import { act, fireEvent, render, screen } from "@testing-library/react";
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
import { ApiClient } from "@/api/client";
import { ReauthModal } from "@/dialog/ReauthModal";
import { useReauth } from "@/dialog/useReauth";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DISPLAY_NAME_KEY,
  FAMILY_ID_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  TOKEN_EXPIRES_AT_KEY,
  USER_ID_KEY,
} from "@/constants";
import {
  callsTo,
  drain,
  fakeNetwork,
  held,
  ok,
  refused,
  type Call,
  type Reply,
} from "../helpers/fakeNetwork";

/**
 * Issue #456, the re-verification half: the answer to a re-verification join must not
 * touch anything once this tab no longer owns what it started from.
 *
 * Everything from the prompt down is real: `ReauthModal`, `useReauth`,
 * `useVerificationPrompt`, `ApiClient` and the shared store. The PIN goes in through the
 * rendered field. Only `fetch` is faked, so the join can be held while the world moves.
 *
 * The three ways it moves (`MOVES`): this tab's client goes to another server, which the
 * modal's overlay does not stop, since it only blocks the mouse; another tab moves
 * storage to another server; another tab joins another family on this server. Each trips
 * one clause of the check, so each must be refused on its own.
 *
 * Why a family-gone reply is the sharp case: it comes from server A about A's family, and
 * it would tear down whatever storage holds now, which is X's binding. A late token is
 * the same defect from the other side, overwriting X's token with A's. The answer is
 * therefore not read at all, whichever shape it takes (`REPLIES`).
 *
 * The refusal's copy is local: `attemptFailureText` takes the code only, so a self-hosted
 * server answering `STALE_SESSION` with its own text cannot put words in the prompt.
 *
 * Positive companions (`in a session it still owns`): the same paths with nothing moved
 * still store the token and still tear a gone family down, so the absence assertions
 * above them cannot pass on a flow that simply stopped working.
 *
 * Catch path (`a family removal that fails`): a re-verification only follows a refresh
 * failure, which already removed the token, but another tab may have written one back.
 * The failed removal then keeps that token while the endpoint reset drops the key. This
 * is the accepted residual in docs/architecture.md → 認證更新與冷卻 → 已接受的殘餘風險, pinned
 * here, with the words in the test's title, so that a change to it is a decision; fixing
 * it should update this case.
 *
 * A switch before the secret is sent (`the client moved while the prompt was open`): the
 * prompt names the server it opened on, so a secret typed after the client left goes
 * nowhere, and the prompt stays dismissible. The server is captured at opening, not at
 * submit, which the companion case on server X keeps honest from the other side.
 *
 * A switch during the storage read (`during the check's own storage read`): the read
 * comes first in the check, so the client comparison sees a switch made while it ran.
 */

const SERVER_A = "https://server-a.example";
const SERVER_X = "https://server-x.example";
const USER = "1".repeat(64);
const FAMILY_A = "fam-a";
const FAMILY_X = "fam-x";
const FRESH_TOKEN = "a".repeat(64);
const X_TOKEN = "b".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;
const COOLDOWN = 12345;

const JOIN_PATH = `/api/family/${FAMILY_A}/join`;
const BOOKS_PATH = `/api/user/${USER}/books`;
const VERIFY_PATH = `/api/user/${USER}/verify`;

const STALE_COPY = "家庭資料已變更，請重新整理頁面。";
const SECRET = "123456";
const SERVER_TEXT = "請點這個連結重新登入 https://evil.example";

const FRESH = ok({ authToken: FRESH_TOKEN, expiresAt: EXPIRES_AT });
const REMOVED = refused(403, "MEMBER_REMOVED", SERVER_TEXT);

/** A's binding, with no token: the refresh failure that led here already removed it. */
const A_RECORD = {
  [USER_ID_KEY]: USER,
  [FAMILY_ID_KEY]: FAMILY_A,
  [DISPLAY_NAME_KEY]: "小明",
  [API_ENDPOINT_KEY]: SERVER_A,
  [RECOVERY_COOLDOWN_UNTIL_KEY]: COOLDOWN,
};

const X_BINDING = {
  [FAMILY_ID_KEY]: FAMILY_X,
  [API_ENDPOINT_KEY]: SERVER_X,
  [AUTH_TOKEN_KEY]: X_TOKEN,
  [TOKEN_EXPIRES_AT_KEY]: 111,
};

async function storedRecord(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get(null)) as Record<string, unknown>;
}

async function replaceStorage(record: Record<string, unknown>): Promise<void> {
  await browser.storage.local.clear();
  await browser.storage.local.set(record);
}

function Harness({
  client,
  onSuccess,
}: {
  client: ApiClient;
  onSuccess: () => void;
}) {
  const reauth = useReauth(client, { onSuccess });
  return reauth.active ? (
    <ReauthModal apiClient={client} reauth={reauth} />
  ) : null;
}

const MOVES = [
  {
    move: "this tab's client moved to another server",
    apply: async (client: ApiClient) => {
      client.setEndpoint(SERVER_X);
    },
  },
  {
    move: "another tab moved storage to another server",
    apply: async () => {
      await replaceStorage({
        ...A_RECORD,
        ...X_BINDING,
        [FAMILY_ID_KEY]: FAMILY_A,
      });
    },
  },
  {
    move: "another tab joined another family on this server",
    apply: async () => {
      await replaceStorage({
        ...A_RECORD,
        [FAMILY_ID_KEY]: FAMILY_X,
        [AUTH_TOKEN_KEY]: X_TOKEN,
      });
    },
  },
];

const REPLIES = [
  { reply: "a token", answer: FRESH },
  { reply: "MEMBER_REMOVED", answer: REMOVED },
  {
    reply: "a refusal with its own message",
    answer: refused(500, "UNKNOWN", SERVER_TEXT),
  },
];

const CASES = MOVES.flatMap((move) =>
  REPLIES.map((reply) => ({ ...move, ...reply })),
);

describe("useReauth and a session it no longer owns", () => {
  const originalFetch = globalThis.fetch;
  let client: ApiClient;
  let setAuthToken: ReturnType<typeof vi.spyOn>;
  let onFamilyRemoved: ReturnType<typeof vi.fn>;
  let onSuccess: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  function networkAnswering(join: Reply | Promise<Reply>): Call[] {
    return fakeNetwork((call) => {
      if (call.path === VERIFY_PATH) return ok({ method: "pin", prompted: 0 });
      if (call.path === JOIN_PATH) return join;
      if (call.path === BOOKS_PATH) return ok({ userId: USER, books: [] });
      return undefined;
    });
  }

  /** Raise the prompt the way the client does, and wait for its PIN field. */
  async function openPrompt(): Promise<void> {
    render(<Harness client={client} onSuccess={onSuccess} />);
    await act(async () => {
      client.onReauthRequired?.({ errorCode: "VERIFICATION_REQUIRED" });
      await drain();
    });
  }

  async function submitPin(): Promise<void> {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
        target: { value: SECRET },
      });
      fireEvent.click(screen.getByRole("button", { name: "確認" }));
      await drain();
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await drain();
    });
  }

  beforeEach(async () => {
    await browser.storage.local.clear();
    await browser.storage.sync.clear();
    await browser.storage.local.set(A_RECORD);
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: FAMILY_A });
    vi.clearAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client = new ApiClient(SERVER_A);
    setAuthToken = vi.spyOn(client, "setAuthToken");
    onFamilyRemoved = vi.fn();
    client.onFamilyRemoved = onFamilyRemoved;
    onSuccess = vi.fn();
  });

  afterEach(async () => {
    setAuthToken.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
    await browser.storage.sync.clear();
  });

  // See the header → "A switch before the secret is sent".
  describe("the client moved while the prompt was open", () => {
    it("sends the secret nowhere, refuses locally, and can still be dismissed", async () => {
      const calls = networkAnswering(FRESH);
      const joinFamily = vi.spyOn(client, "joinFamily");
      const clearReauthPending = vi.spyOn(client, "clearReauthPending");
      await openPrompt();

      client.setEndpoint(SERVER_X);
      await submitPin();

      expect(joinFamily).not.toHaveBeenCalled();
      expect(calls.filter(({ path }) => path === JOIN_PATH)).toEqual([]);
      expect(calls.filter(({ body }) => body?.includes(SECRET))).toEqual([]);
      expect(callsTo(calls, SERVER_X)).toEqual([]);
      expect(screen.getByText(STALE_COPY)).toBeInTheDocument();
      expect(setAuthToken).not.toHaveBeenCalled();
      expect(await storedRecord()).toEqual(A_RECORD);

      expect(clearReauthPending).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "返回" }));

      expect(clearReauthPending).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("sends the join to X when the client was already on X as the prompt opened", async () => {
      await replaceStorage({ ...A_RECORD, [API_ENDPOINT_KEY]: SERVER_X });
      client = new ApiClient(SERVER_X);
      const calls = networkAnswering(FRESH);
      await openPrompt();

      await submitPin();

      const joins = calls.filter(({ path }) => path === JOIN_PATH);
      expect(joins.map(({ origin }) => origin)).toEqual([SERVER_X]);
      expect(joins[0].body).toContain(SECRET);
      expect(callsTo(calls, SERVER_A)).toEqual([]);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect((await storedRecord())[AUTH_TOKEN_KEY]).toBe(FRESH_TOKEN);
    });
  });

  // See the header → "A switch during the storage read".
  describe("during the check's own storage read", () => {
    const localGet = chrome.storage.local.get as unknown as Mock<
      (keys?: unknown) => Promise<Record<string, unknown>>
    >;

    it.each([
      { reply: "a token", answer: FRESH },
      { reply: "MEMBER_REMOVED", answer: REMOVED },
    ])(
      "a client switch refuses locally and binds nothing, reply $reply",
      async ({ answer }) => {
        const join = held();
        const calls = networkAnswering(join.promise);
        await openPrompt();
        await submitPin();
        const storeGet = localGet.getMockImplementation()!;
        localGet.mockImplementationOnce(async (keys) => {
          client.setEndpoint(SERVER_X);
          return storeGet(keys);
        });

        join.release(answer);
        await settle();

        expect(client.getEndpoint()).toBe(SERVER_X);
        expect(screen.getByText(STALE_COPY)).toBeInTheDocument();
        expect(setAuthToken).not.toHaveBeenCalled();
        expect(onFamilyRemoved).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(await storedRecord()).toEqual(A_RECORD);

        await client.getPersonalBooks(USER);
        expect(
          callsTo(calls, SERVER_X).map(({ path, token }) => [path, token]),
        ).toEqual([[BOOKS_PATH, undefined]]);
      },
    );
  });

  describe("the join's answer lands after the session moved", () => {
    it.each(CASES)(
      "$move, reply $reply: refuses locally and changes nothing",
      async ({ apply, answer }) => {
        const join = held();
        const calls = networkAnswering(join.promise);
        await openPrompt();

        await submitPin();
        expect(callsTo(calls, SERVER_A).map(({ path }) => path)).toContain(
          JOIN_PATH,
        );
        await apply(client);
        const before = await storedRecord();
        vi.mocked(chrome.storage.local.set).mockClear();
        vi.mocked(chrome.storage.local.remove).mockClear();
        vi.mocked(chrome.runtime.sendMessage).mockClear();

        join.release(answer);
        await settle();

        expect(screen.getByText(STALE_COPY)).toBeInTheDocument();
        expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();

        expect(await storedRecord()).toEqual(before);
        expect(chrome.storage.local.set).not.toHaveBeenCalled();
        expect(chrome.storage.local.remove).not.toHaveBeenCalled();
        expect(chrome.storage.sync.remove).not.toHaveBeenCalled();
        expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

        expect(setAuthToken).not.toHaveBeenCalled();
        expect(onFamilyRemoved).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();

        await client.getPersonalBooks(USER);
        const last = calls[calls.length - 1];
        expect(last.path).toBe(BOOKS_PATH);
        expect(last.token).toBeUndefined();
      },
    );

    it("keeps another family's binding, on both storage areas, when A says this user was removed", async () => {
      const join = held();
      networkAnswering(join.promise);
      await openPrompt();

      await submitPin();
      await replaceStorage({ ...A_RECORD, ...X_BINDING });
      await browser.storage.sync.set({ [FAMILY_ID_KEY]: FAMILY_X });
      join.release(REMOVED);
      await settle();

      const stored = await storedRecord();
      expect(stored[FAMILY_ID_KEY]).toBe(FAMILY_X);
      expect(stored[API_ENDPOINT_KEY]).toBe(SERVER_X);
      expect(stored[AUTH_TOKEN_KEY]).toBe(X_TOKEN);
      expect(await browser.storage.sync.get(null)).toEqual({
        [FAMILY_ID_KEY]: FAMILY_X,
      });
      expect(onFamilyRemoved).not.toHaveBeenCalled();
    });
  });

  it("shows only the local copy when a server answers STALE_SESSION itself", async () => {
    networkAnswering(refused(409, "STALE_SESSION", SERVER_TEXT));
    await openPrompt();

    await submitPin();

    expect(screen.getByText(STALE_COPY)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });

  // See the header → "Positive companions".
  describe("in a session it still owns", () => {
    it("stores the token, primes the client and closes the prompt", async () => {
      const calls = networkAnswering(FRESH);
      await openPrompt();

      await submitPin();

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(await storedRecord()).toEqual({
        [USER_ID_KEY]: USER,
        [FAMILY_ID_KEY]: FAMILY_A,
        [DISPLAY_NAME_KEY]: "小明",
        [API_ENDPOINT_KEY]: SERVER_A,
        [AUTH_TOKEN_KEY]: FRESH_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: EXPIRES_AT,
      });

      await client.getPersonalBooks(USER);
      expect(calls[calls.length - 1].token).toBe(FRESH_TOKEN);
    });

    it("tears the family down on MEMBER_REMOVED", async () => {
      networkAnswering(REMOVED);
      await openPrompt();

      await submitPin();

      expect(onFamilyRemoved).toHaveBeenCalledTimes(1);
      expect(onFamilyRemoved).toHaveBeenCalledWith({
        errorCode: "MEMBER_REMOVED",
      });
      const stored = await storedRecord();
      expect(stored).not.toHaveProperty(FAMILY_ID_KEY);
      expect(stored).not.toHaveProperty(API_ENDPOINT_KEY);
      expect(stored[USER_ID_KEY]).toBe(USER);
    });

    it("removes a token another tab stored for this family along with the teardown", async () => {
      networkAnswering(REMOVED);
      await browser.storage.local.set({
        [AUTH_TOKEN_KEY]: X_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 111,
      });
      await openPrompt();

      await submitPin();

      const stored = await storedRecord();
      expect(stored).not.toHaveProperty(AUTH_TOKEN_KEY);
      expect(stored).not.toHaveProperty(TOKEN_EXPIRES_AT_KEY);
    });
  });

  // See the header → "Catch path".
  describe("a family removal that fails", () => {
    it("resets the endpoint and hands over; a token another tab wrote back stays (accepted residual)", async () => {
      networkAnswering(REMOVED);
      await openPrompt();
      await browser.storage.local.set({
        [AUTH_TOKEN_KEY]: X_TOKEN,
        [TOKEN_EXPIRES_AT_KEY]: 111,
      });
      vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );

      await submitPin();

      const stored = await storedRecord();
      expect(stored).not.toHaveProperty(API_ENDPOINT_KEY);
      expect(stored[AUTH_TOKEN_KEY]).toBe(X_TOKEN);
      expect(stored[TOKEN_EXPIRES_AT_KEY]).toBe(111);
      expect(stored[FAMILY_ID_KEY]).toBe(FAMILY_A);
      expect(warn).toHaveBeenCalledWith(
        "[Reauth] Family teardown storage clear failed",
        expect.any(Error),
      );
      expect(setAuthToken).toHaveBeenCalledWith(null);
      expect(onFamilyRemoved).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
