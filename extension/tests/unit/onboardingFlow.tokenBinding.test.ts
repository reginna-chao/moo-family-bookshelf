import { webcrypto } from "node:crypto";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import browser from "webextension-polyfill";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { ApiClient } from "@/api/client";
import { updatePendingBorrowBadge } from "@/content/pendingBorrowBadge";
import { applyStoredSession } from "@/dialog/applyStoredSession";
import { clearStoredFamilyBinding } from "@/dialog/familyBindingReset";
import {
  createNewFamily,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "@/dialog/onboardingFlow";
import type { useAutoSetup } from "@/dialog/useAutoSetup";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  USER_ID_KEY,
} from "@/constants";
import {
  callsTo,
  drain,
  fakeNetwork,
  ok,
  type Call,
  type Route,
} from "../helpers/fakeNetwork";
import {
  clearReadmooEmailCookie,
  setReadmooEmailCookie,
} from "../helpers/readmooEmailCookie";

/**
 * Issue #456, the onboarding half: a stale onboarding screen must not pair the token
 * it receives with a server that did not issue it.
 *
 * The attack needs no race. Tab 1 sits on onboarding, its client on the official
 * server. Tab 2 joins a family on server B, which leaves B and B's token in the
 * shared storage. Tab 1 then creates a family, or joins with a code carrying no
 * `@host`. The official server issues a token, and storage would now pair it with
 * B: every later boot sends it there, and the floating button's badge reads the same
 * pair. The custom-server mirror is the same defect the other way round.
 *
 * Everything here is real except `fetch`: `ApiClient`, the onboarding flows, the sync
 * code codec, `applyStoredSession` and the badge, on the shared store from
 * `tests/setup.ts`. So the assertion is the consequence, which server receives which
 * token, not only the storage shape.
 *
 * `sendFromStorage`: a fresh client booted from what storage now holds, as the next
 * Dialog open would be, plus the badge, which reads storage on its own. Its result is
 * compared whole, so a request to any other server fails the same assertion.
 *
 * A leave whose storage removal failed (`a leave that could not clear storage`): the
 * dialog moves on regardless, so storage keeps server B and B's token while the client
 * is back on the official default. The next create must not pair the official token
 * with B.
 *
 * Another tab's write between this flow's two storage calls (`afterFirstWrite`): the
 * hook fires after whichever call comes first, so it needs no knowledge of their order.
 * The assertion is that the OFFICIAL token never pairs with server B. The reverse, B's
 * token left without a key, is the accepted residual in docs/architecture.md → 認證更新與冷卻
 * → 已接受的殘餘風險, and is deliberately not asserted either way.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
  });
}

const EMAIL = "owner@example.com";
const USER = await deriveUserId(EMAIL);
const CREATED_FAMILY = "created-1";
const JOINED_FAMILY = "joined-1";

const OFFICIAL = new URL(DEFAULT_API_ENDPOINT).origin;
const SERVER_B = "https://server-b.example";
const OFFICIAL_TOKEN = "a".repeat(64);
const B_TOKEN = "b".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;

const BOOKS_PATH = `/api/user/${USER}/books`;
const borrowPathOf = (familyId: string) => `/api/family/${familyId}/borrow`;

const tokenOf = (origin: string) =>
  origin === OFFICIAL ? OFFICIAL_TOKEN : B_TOKEN;

const issue = (familyId: string, origin: string) =>
  ok({ familyId, authToken: tokenOf(origin), expiresAt: EXPIRES_AT });

/** Every server issues its own token, on create and on join. */
const servers: Route = (call) => {
  if (call.method === "POST" && call.path === "/api/family") {
    return issue(CREATED_FAMILY, call.origin);
  }
  if (call.path.endsWith("/join")) return issue(JOINED_FAMILY, call.origin);
  if (call.path === BOOKS_PATH) return ok({ userId: USER, books: [] });
  if (call.path.endsWith("/borrow")) return ok([]);
  if (call.path.endsWith("/endpoint")) return ok({ ok: true });
  return undefined;
};

const IDENTITY = { userId: USER, displayName: "Name" };

function recoveryOpts(apiClient: ApiClient) {
  return {
    ...IDENTITY,
    apiClient,
    familyId: JOINED_FAMILY,
    autoSetup: {
      syncBooks: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof useAutoSetup>,
    onFamilyJoined: vi.fn(),
  };
}

const FLOWS = [
  {
    flow: "createNewFamily",
    familyId: CREATED_FAMILY,
    run: (apiClient: ApiClient) => createNewFamily({ ...IDENTITY, apiClient }),
  },
  {
    flow: "performJoin with a code carrying no @host",
    familyId: JOINED_FAMILY,
    run: (apiClient: ApiClient) =>
      performJoin({
        ...IDENTITY,
        apiClient,
        syncCodeInput: `moo-${JOINED_FAMILY}`,
      }),
  },
  {
    flow: "tryAutoRecovery",
    familyId: JOINED_FAMILY,
    run: (apiClient: ApiClient) => tryAutoRecovery(recoveryOpts(apiClient)),
  },
  {
    flow: "performSoloRecovery",
    familyId: JOINED_FAMILY,
    run: (apiClient: ApiClient) => performSoloRecovery(recoveryOpts(apiClient)),
  },
];

type StorageWrite = Mock<(arg: unknown) => Promise<void>>;
const localSet = browser.storage.local.set as unknown as StorageWrite;
const localRemove = browser.storage.local.remove as unknown as StorageWrite;
const storeSet = localSet.getMockImplementation()!;
const storeRemove = localRemove.getMockImplementation()!;

/** Run `effect` once, right after the next local storage write takes hold. */
function afterFirstWrite(effect: () => Promise<void>): void {
  let fired = false;
  const firing =
    (store: (arg: unknown) => Promise<void>) => async (arg: unknown) => {
      await store(arg);
      if (fired) return;
      fired = true;
      await effect();
    };
  localSet.mockImplementation(firing(storeSet));
  localRemove.mockImplementation(firing(storeRemove));
}

async function storedRecord(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get(null)) as Record<string, unknown>;
}

describe("onboarding flows and the token they receive", () => {
  const originalFetch = globalThis.fetch;
  let button: HTMLElement;
  let calls: Call[];

  /** See the header → "`sendFromStorage`". */
  async function sendFromStorage(): Promise<Array<Array<string | undefined>>> {
    const start = calls.length;
    const client = new ApiClient();
    applyStoredSession(client, await storedRecord());
    await client.getPersonalBooks(USER);
    await updatePendingBorrowBadge(button);
    return calls
      .slice(start)
      .map(({ origin, path, token }) => [origin, path, token]);
  }

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
    button = document.createElement("button");
    document.body.appendChild(button);
    setReadmooEmailCookie(EMAIL);
    calls = fakeNetwork(servers);
  });

  afterEach(async () => {
    localSet.mockImplementation(storeSet);
    localRemove.mockImplementation(storeRemove);
    globalThis.fetch = originalFetch;
    clearReadmooEmailCookie();
    button.remove();
    await browser.storage.local.clear();
  });

  describe("on the official server, with another tab's server B in storage", () => {
    beforeEach(async () => {
      await browser.storage.local.set({
        [USER_ID_KEY]: USER,
        [API_ENDPOINT_KEY]: SERVER_B,
        [AUTH_TOKEN_KEY]: B_TOKEN,
      });
    });

    it.each(FLOWS)(
      "$flow leaves the official token with no endpoint key, and sends nothing to B",
      async ({ run, familyId }) => {
        await run(new ApiClient());
        await drain();

        const stored = await storedRecord();
        expect(stored[AUTH_TOKEN_KEY]).toBe(OFFICIAL_TOKEN);
        expect(stored).not.toHaveProperty(API_ENDPOINT_KEY);
        expect(stored[FAMILY_ID_KEY]).toBe(familyId);

        expect(await sendFromStorage()).toEqual([
          [OFFICIAL, BOOKS_PATH, OFFICIAL_TOKEN],
          [OFFICIAL, borrowPathOf(familyId), OFFICIAL_TOKEN],
        ]);
        expect(callsTo(calls, SERVER_B)).toEqual([]);
      },
    );
  });

  describe("on server B, with the official pair in storage", () => {
    beforeEach(async () => {
      await browser.storage.local.set({
        [USER_ID_KEY]: USER,
        [AUTH_TOKEN_KEY]: OFFICIAL_TOKEN,
      });
    });

    it.each(FLOWS)(
      "$flow pairs B's token with B, and the official token never reaches B",
      async ({ run, familyId }) => {
        await run(new ApiClient(SERVER_B));
        await drain();

        const stored = await storedRecord();
        expect(stored[AUTH_TOKEN_KEY]).toBe(B_TOKEN);
        expect(stored[API_ENDPOINT_KEY]).toBe(SERVER_B);
        expect(stored[FAMILY_ID_KEY]).toBe(familyId);

        expect(await sendFromStorage()).toEqual([
          [SERVER_B, BOOKS_PATH, B_TOKEN],
          [SERVER_B, borrowPathOf(familyId), B_TOKEN],
        ]);
        expect(callsTo(calls, OFFICIAL)).toEqual([]);
        expect(calls.filter(({ token }) => token === OFFICIAL_TOKEN)).toEqual(
          [],
        );
      },
    );
  });

  // See the header → "Another tab's write between this flow's two storage calls".
  it.each(FLOWS)(
    "$flow on the official server: another tab's custom pair landing mid-write never pairs B with the official token",
    async ({ run }) => {
      const otherTab = vi.fn(async () => {
        await storeSet({
          [API_ENDPOINT_KEY]: SERVER_B,
          [AUTH_TOKEN_KEY]: B_TOKEN,
        });
      });
      afterFirstWrite(otherTab);

      await run(new ApiClient());
      await drain();

      expect(otherTab).toHaveBeenCalledTimes(1);
      const stored = await storedRecord();
      expect([stored[API_ENDPOINT_KEY], stored[AUTH_TOKEN_KEY]]).not.toEqual([
        SERVER_B,
        OFFICIAL_TOKEN,
      ]);
      await sendFromStorage();
      expect(
        callsTo(calls, SERVER_B).filter(
          ({ token }) => token === OFFICIAL_TOKEN,
        ),
      ).toEqual([]);
    },
  );

  it("performJoin with an @host equal to the official URL ends with no endpoint key", async () => {
    await browser.storage.local.set({
      [API_ENDPOINT_KEY]: SERVER_B,
      [AUTH_TOKEN_KEY]: B_TOKEN,
    });
    const client = new ApiClient(SERVER_B);

    const result = await performJoin({
      ...IDENTITY,
      apiClient: client,
      syncCodeInput: `moo-${JOINED_FAMILY}@${DEFAULT_API_ENDPOINT}`,
    });

    expect(result.ok).toBe(true);
    const stored = await storedRecord();
    expect(stored).not.toHaveProperty(API_ENDPOINT_KEY);
    expect(stored[AUTH_TOKEN_KEY]).toBe(OFFICIAL_TOKEN);
  });

  // See the header → "A leave whose storage removal failed".
  describe("a leave that could not clear storage", () => {
    async function leaveWithFailedRemoval(): Promise<ApiClient> {
      await browser.storage.local.set({
        [USER_ID_KEY]: USER,
        [FAMILY_ID_KEY]: JOINED_FAMILY,
        [API_ENDPOINT_KEY]: SERVER_B,
        [AUTH_TOKEN_KEY]: B_TOKEN,
      });
      const client = new ApiClient(SERVER_B);
      client.setAuthToken(B_TOKEN);

      localRemove.mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(clearStoredFamilyBinding()).rejects.toThrow(
        "storage unavailable",
      );
      // What the dialog does with the live client after a leave, failed removal or not.
      client.setAuthToken(null);
      client.setEndpoint(DEFAULT_API_ENDPOINT);

      const stored = await storedRecord();
      expect(stored[API_ENDPOINT_KEY]).toBe(SERVER_B);
      expect(stored[AUTH_TOKEN_KEY]).toBe(B_TOKEN);
      return client;
    }

    it("does not pair the official token with the server it left", async () => {
      const client = await leaveWithFailedRemoval();

      await createNewFamily({ ...IDENTITY, apiClient: client });

      const stored = await storedRecord();
      expect(stored).not.toHaveProperty(API_ENDPOINT_KEY);
      expect(stored[AUTH_TOKEN_KEY]).toBe(OFFICIAL_TOKEN);
      expect(await sendFromStorage()).toEqual([
        [OFFICIAL, BOOKS_PATH, OFFICIAL_TOKEN],
        [OFFICIAL, borrowPathOf(CREATED_FAMILY), OFFICIAL_TOKEN],
      ]);
      expect(callsTo(calls, SERVER_B)).toEqual([]);
    });

    it("keeps the old pair whole when the create's own write fails too", async () => {
      const client = await leaveWithFailedRemoval();
      localSet.mockRejectedValueOnce(new Error("storage still unavailable"));

      await expect(
        createNewFamily({ ...IDENTITY, apiClient: client }),
      ).rejects.toThrow("storage still unavailable");

      const stored = await storedRecord();
      expect(stored[API_ENDPOINT_KEY]).toBe(SERVER_B);
      expect(stored[AUTH_TOKEN_KEY]).toBe(B_TOKEN);
      expect(stored[FAMILY_ID_KEY]).toBe(JOINED_FAMILY);
    });

    it("stays on the official server when only the create's key removal fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = await leaveWithFailedRemoval();
      localRemove.mockRejectedValueOnce(new Error("storage still unavailable"));

      try {
        await createNewFamily({ ...IDENTITY, apiClient: client });

        const stored = await storedRecord();
        expect(stored[API_ENDPOINT_KEY]).toBe(DEFAULT_API_ENDPOINT);
        expect(stored[AUTH_TOKEN_KEY]).toBe(OFFICIAL_TOKEN);
        expect(await sendFromStorage()).toEqual([
          [OFFICIAL, BOOKS_PATH, OFFICIAL_TOKEN],
          [OFFICIAL, borrowPathOf(CREATED_FAMILY), OFFICIAL_TOKEN],
        ]);
        expect(callsTo(calls, SERVER_B)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
