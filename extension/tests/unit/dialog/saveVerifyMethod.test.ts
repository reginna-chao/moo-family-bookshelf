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
import { saveVerifyMethod } from "@/dialog/saveVerifyMethod";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  TOKEN_EXPIRES_AT_KEY,
  TOKEN_SERVER_KEY,
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
} from "../../helpers/fakeNetwork";

/**
 * saveVerifyMethod (#456): a new PIN or pattern rotates the auth token, and storage
 * takes the rotated token only while it still names this client's server.
 *
 * The defect: tab 1 is on server A and tab 2 has moved storage to server X. Saving a
 * PIN in tab 1 used to write A's rotated token over X's, pairing it with X, so the
 * next boot of any tab sends A's token to X. With the check, the token stays in tab 1's
 * memory, where A still gets it, and the save still reports success: the PIN really
 * did change on A, whatever storage holds.
 *
 * A storage failure is therefore never a failed save either; it is logged. A rotated
 * token that lands after THIS client moved is `ApiClient.setVerifyMethod`'s case, in
 * tests/unit/api/tokenBinding.test.ts → "a rotated token from setVerifyMethod".
 *
 * Real `ApiClient` on the shared store; only `fetch` is faked. The save is held open
 * while storage moves, as another tab's write would land.
 *
 * A stored rotated token goes in ONE write with the server that issued it
 * (`moo:authTokenServer`: `official` for the official default, else the server URL).
 */

const SERVER_A = "https://server-a.example";
const SERVER_X = "https://server-x.example";
const OFFICIAL = new URL(DEFAULT_API_ENDPOINT).origin;
const USER = "1".repeat(64);
const VERIFY_PATH = `/api/user/${USER}/verify`;
const BOOKS_PATH = `/api/user/${USER}/books`;

const OLD_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);
const X_TOKEN = "c".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;

const ROTATED = ok({
  method: "pin",
  prompted: 1,
  authToken: ROTATED_TOKEN,
  expiresAt: EXPIRES_AT,
});

const localGet = browser.storage.local.get as unknown as Mock<
  (keys?: unknown) => Promise<Record<string, unknown>>
>;
const localSet = browser.storage.local.set as unknown as Mock<
  (items: Record<string, unknown>) => Promise<void>
>;
const storeGet = localGet.getMockImplementation()!;

async function storedRecord(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get(null)) as Record<string, unknown>;
}

function networkAnswering(verify: Reply | Promise<Reply>): Call[] {
  return fakeNetwork((call) => {
    if (call.path === VERIFY_PATH) return verify;
    if (call.path === BOOKS_PATH) return ok({ userId: USER, books: [] });
    return undefined;
  });
}

function clientOn(server: string): ApiClient {
  const client = new ApiClient(server);
  client.setAuthToken(OLD_TOKEN);
  return client;
}

function save(client: ApiClient) {
  return saveVerifyMethod(client, USER, "pin", "123456");
}

describe("saveVerifyMethod", () => {
  const originalFetch = globalThis.fetch;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    localGet.mockImplementation(storeGet);
    warn.mockRestore();
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
  });

  describe("another tab moved storage to another server while the save ran", () => {
    const X_PAIR = {
      [USER_ID_KEY]: USER,
      [FAMILY_ID_KEY]: "fam-x",
      [API_ENDPOINT_KEY]: SERVER_X,
      [AUTH_TOKEN_KEY]: X_TOKEN,
      [TOKEN_EXPIRES_AT_KEY]: 111,
    };

    async function saveWhileStorageMoves() {
      const response = held();
      const calls = networkAnswering(response.promise);
      await browser.storage.local.set({
        [API_ENDPOINT_KEY]: SERVER_A,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
      });
      const client = clientOn(SERVER_A);

      const saving = save(client);
      await drain();
      await browser.storage.local.clear();
      await browser.storage.local.set(X_PAIR);
      localSet.mockClear();
      response.release(ROTATED);
      const result = await saving;
      return { calls, client, result };
    }

    it("leaves the stored pair untouched", async () => {
      await saveWhileStorageMoves();

      expect(localSet).not.toHaveBeenCalled();
      expect(await storedRecord()).toEqual(X_PAIR);
    });

    it("still reports the save as a success", async () => {
      const { result } = await saveWhileStorageMoves();

      expect(result.error).toBeUndefined();
      expect(result.data?.method).toBe("pin");
      expect(warn).not.toHaveBeenCalled();
    });

    it("keeps the rotated token in memory, for its own server only", async () => {
      const { calls, client } = await saveWhileStorageMoves();

      await client.getPersonalBooks(USER);

      expect(calls[calls.length - 1]).toMatchObject({
        origin: SERVER_A,
        path: BOOKS_PATH,
        token: ROTATED_TOKEN,
      });
      expect(callsTo(calls, SERVER_X)).toEqual([]);
    });
  });

  describe("storage still names this client's server", () => {
    it.each([
      {
        name: "a custom server",
        server: SERVER_A,
        seed: { [FAMILY_ID_KEY]: "fam-a", [API_ENDPOINT_KEY]: SERVER_A },
        marker: SERVER_A,
      },
      {
        name: "the official default, with no key",
        server: OFFICIAL,
        seed: { [FAMILY_ID_KEY]: "fam-a" },
        marker: "official",
      },
    ])(
      "stores the rotated token, its expiry and its issuer in one write on $name",
      async ({ server, seed, marker }) => {
        networkAnswering(ROTATED);
        await browser.storage.local.set({
          ...seed,
          [AUTH_TOKEN_KEY]: OLD_TOKEN,
        });
        localSet.mockClear();

        const result = await save(clientOn(server));

        expect(result.error).toBeUndefined();
        expect(localSet).toHaveBeenCalledTimes(1);
        expect(localSet.mock.calls[0][0]).toEqual({
          [AUTH_TOKEN_KEY]: ROTATED_TOKEN,
          [TOKEN_SERVER_KEY]: marker,
          [TOKEN_EXPIRES_AT_KEY]: EXPIRES_AT,
        });
        expect(await storedRecord()).toEqual({
          ...seed,
          [AUTH_TOKEN_KEY]: ROTATED_TOKEN,
          [TOKEN_SERVER_KEY]: marker,
          [TOKEN_EXPIRES_AT_KEY]: EXPIRES_AT,
        });
      },
    );

    it("writes nothing when the save itself is refused", async () => {
      networkAnswering(refused(403, "VERIFICATION_FAILED"));
      const seed = {
        [API_ENDPOINT_KEY]: SERVER_A,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
      };
      await browser.storage.local.set(seed);
      localSet.mockClear();

      const result = await save(clientOn(SERVER_A));

      expect(result.error?.code).toBe("VERIFICATION_FAILED");
      expect(localSet).not.toHaveBeenCalled();
      expect(await storedRecord()).toEqual(seed);
    });
  });

  it("does not store the token over an unusable endpoint", async () => {
    networkAnswering(ROTATED);
    const seed = { [API_ENDPOINT_KEY]: 42, [AUTH_TOKEN_KEY]: OLD_TOKEN };
    await browser.storage.local.set(seed);

    await save(clientOn(OFFICIAL));

    expect(await storedRecord()).toEqual(seed);
  });

  describe("a storage failure", () => {
    const SEED = { [API_ENDPOINT_KEY]: SERVER_A, [AUTH_TOKEN_KEY]: OLD_TOKEN };

    async function expectLoggedSuccess(client: ApiClient, calls: Call[]) {
      const result = await save(client);

      expect(result.error).toBeUndefined();
      expect(result.data?.method).toBe("pin");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe(
        "[VerificationSettings] Failed to store the rotated token",
      );

      await client.getPersonalBooks(USER);
      expect(calls[calls.length - 1].token).toBe(ROTATED_TOKEN);
    }

    it("on the read is logged, writes nothing, and the save still succeeds", async () => {
      const calls = networkAnswering(ROTATED);
      await browser.storage.local.set(SEED);
      const client = clientOn(SERVER_A);
      localSet.mockClear();
      localGet.mockRejectedValueOnce(new Error("storage unavailable"));

      await expectLoggedSuccess(client, calls);

      expect(localSet).not.toHaveBeenCalled();
      expect(await storedRecord()).toEqual(SEED);
    });

    it("on the write is logged and the save still succeeds", async () => {
      const calls = networkAnswering(ROTATED);
      await browser.storage.local.set(SEED);
      const client = clientOn(SERVER_A);
      localSet.mockRejectedValueOnce(new Error("storage unavailable"));

      await expectLoggedSuccess(client, calls);

      expect(await storedRecord()).toEqual(SEED);
    });
  });
});
