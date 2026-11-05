import { renderHook, act, waitFor } from "@testing-library/react";
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
import { ApiClient, validateEndpointUrl } from "@/api/client";
import { resolveStoredEndpoint, storageMatches } from "@/api/tokenBinding";
import { saveVerifyMethod } from "@/dialog/saveVerifyMethod";
import { useEndpointSwitch } from "@/dialog/useEndpointSwitch";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  SELF_DEPARTURE_UNTIL_KEY,
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
  type Route,
} from "../../helpers/fakeNetwork";

/**
 * Issue #456: an auth token is only ever sent to the server that issued it.
 *
 * Everything runs through a real `ApiClient`, so `ApiTransport`, `TokenSession`,
 * `doRefreshToken` and `attemptJoinRecovery` are all real. Only `fetch` is faked,
 * and storage is the shared store-backed mock from `tests/setup.ts`, which is what
 * "another tab" writes to here. Every recorded call keeps its origin and bearer
 * token, so an assertion can say which server saw which token, and each negative
 * count sits next to the server it is about.
 *
 * Held responses are deferred promises, released by the test at the moment the
 * interleaving calls for. `drain` is one macrotask: the fake network and the store
 * answer in microtasks, so by then everything not held has had its turn.
 *
 * The interleavings (`INTERLEAVINGS`): the same things can happen while a response
 * is held. This tab can switch server (the session ends); another tab can join
 * another family on another server, move this same family to another server, or
 * join another family on this server. The last three leave this client's session
 * alive, so only the re-read of storage catches them, and each one trips a different
 * half of that comparison. A late response must then change nothing, whichever shape
 * it takes: a token, a failure, or a family-gone code.
 *
 * Why a hostile token: a server that holds its answer until the client has moved
 * on, then answers with a token of its choosing, would otherwise get that token
 * written over the new server's and sent there next. `HOSTILE_TOKEN` is in the
 * issued shape, so it can only be dropped by the binding, never by the shape check.
 *
 * Normal path cases (`same-server recovery`): these are the regression half, and
 * green with or without the fix. They are also the positive companions of every
 * negative assertion here: they pin the refresh and join paths those negatives
 * filter on, and that a family-gone code on the client's own server still tears down.
 *
 * Decision on a confirmed switch (`after a confirmed switch`): the old token is
 * dropped and the user rejoins on the new server, so that block drives the real
 * `useEndpointSwitch` and then sends a request.
 */

const OLD_SERVER = "https://old.example";
const NEW_SERVER = "https://new.example";
const USER = "1".repeat(64);
const OTHER_USER = "2".repeat(64);
const OLD_FAMILY = "fam-old";
const NEW_FAMILY = "fam-new";
const OLD_TOKEN = "a".repeat(64);
const NEW_TOKEN = "b".repeat(64);
const HOSTILE_TOKEN = "c".repeat(64);
const FRESH_TOKEN = "d".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;

const REFRESH_PATH = "/api/auth/refresh";
const BOOKS_PATH = `/api/user/${USER}/books`;
const joinPathOf = (familyId: string) => `/api/family/${familyId}/join`;
const JOIN_PATH = joinPathOf(OLD_FAMILY);

const UNAUTHORIZED = refused(401, "UNAUTHORIZED");
const REFRESH_FAILED = refused(401, "REFRESH_FAILED");
const BOOKS = ok({ userId: USER, books: [] });

/** The first books request on `server` gets a 401; refresh and join answer as given; the rest succeed. */
function deadTokenRoute(
  server: string,
  answers: { refresh?: Reply | Promise<Reply>; join?: Reply | Promise<Reply> },
): Route {
  let answered = false;
  return (call) => {
    if (call.path === REFRESH_PATH) return answers.refresh ?? REFRESH_FAILED;
    if (call.path.endsWith("/join")) {
      return answers.join ?? refused(500, "UNKNOWN");
    }
    if (call.origin === server && call.path === BOOKS_PATH && !answered) {
      answered = true;
      return UNAUTHORIZED;
    }
    return BOOKS;
  };
}

const callsOn = (calls: Call[], suffix: string): Call[] =>
  calls.filter(({ path }) => path.endsWith(suffix));

async function seedStorage(seed: {
  server?: string;
  token?: string;
  familyId?: string;
}): Promise<void> {
  await browser.storage.local.set({
    [USER_ID_KEY]: USER,
    [FAMILY_ID_KEY]: seed.familyId ?? OLD_FAMILY,
    ...(seed.token ? { [AUTH_TOKEN_KEY]: seed.token } : {}),
    ...(seed.server ? { [API_ENDPOINT_KEY]: seed.server } : {}),
  });
}

async function storedRecord(): Promise<Record<string, unknown>> {
  return (await browser.storage.local.get(null)) as Record<string, unknown>;
}

async function storedToken(): Promise<unknown> {
  return (await storedRecord())[AUTH_TOKEN_KEY];
}

/** Replace the whole store, as a write from another tab would leave it. */
async function replaceStorage(seed: {
  server?: string;
  token?: string;
  familyId?: string;
}): Promise<void> {
  await browser.storage.local.clear();
  await seedStorage(seed);
}

function clientOn(server: string, token: string | null = OLD_TOKEN): ApiClient {
  const client = new ApiClient(server);
  if (token) client.setAuthToken(token);
  client.onFamilyRemoved = vi.fn();
  client.onReauthRequired = vi.fn();
  return client;
}

function expectNoCallback(client: ApiClient): void {
  expect(client.onFamilyRemoved).not.toHaveBeenCalled();
  expect(client.onReauthRequired).not.toHaveBeenCalled();
}

function expectNoRefreshOrJoin(calls: Call[]): void {
  expect(callsOn(calls, REFRESH_PATH)).toEqual([]);
  expect(callsOn(calls, "/join")).toEqual([]);
}

/** See the header → "The interleavings". `switchedServer` is the server this client now sits on. */
const INTERLEAVINGS = [
  {
    name: "this tab switched server",
    switchedServer: NEW_SERVER,
    apply: async (client: ApiClient) => {
      client.setEndpoint(NEW_SERVER);
      client.setAuthToken(NEW_TOKEN);
      await replaceStorage({
        server: NEW_SERVER,
        token: NEW_TOKEN,
        familyId: NEW_FAMILY,
      });
    },
  },
  {
    name: "another tab moved storage to another server",
    switchedServer: OLD_SERVER,
    apply: async () => {
      await replaceStorage({
        server: NEW_SERVER,
        token: NEW_TOKEN,
        familyId: NEW_FAMILY,
      });
    },
  },
  {
    name: "another tab moved this same family to another server",
    switchedServer: OLD_SERVER,
    apply: async () => {
      await replaceStorage({ server: NEW_SERVER, familyId: OLD_FAMILY });
    },
  },
  {
    name: "another tab joined another family on the same server",
    switchedServer: OLD_SERVER,
    apply: async () => {
      await replaceStorage({
        server: OLD_SERVER,
        token: NEW_TOKEN,
        familyId: NEW_FAMILY,
      });
    },
  },
];

const localGet = browser.storage.local.get as unknown as Mock<
  (keys?: unknown) => Promise<Record<string, unknown>>
>;
const localRemove = browser.storage.local.remove as unknown as Mock<
  (keys: unknown) => Promise<void>
>;
const storeGet = localGet.getMockImplementation()!;
const storeRemove = localRemove.getMockImplementation()!;

const keysOf = (keys: unknown): unknown[] =>
  Array.isArray(keys) ? keys : [keys];

/** Run `effect` during the first read of `key`, before that read answers. */
function duringReadOf(key: string, effect: () => Promise<void>): void {
  localGet.mockImplementation(async (keys) => {
    if (keysOf(keys).includes(key)) {
      localGet.mockImplementation(storeGet);
      await effect();
    }
    return storeGet(keys);
  });
}

/** Run `effect` during the first removal of `key`, after that removal took hold. */
function duringRemovalOf(key: string, effect: () => Promise<void>): void {
  localRemove.mockImplementation(async (keys) => {
    await storeRemove(keys);
    if (keysOf(keys).includes(key)) {
      localRemove.mockImplementation(storeRemove);
      await effect();
    }
  });
}

describe("ApiClient token binding", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    localGet.mockImplementation(storeGet);
    localRemove.mockImplementation(storeRemove);
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
  });

  describe("a 401 from a server the client has left", () => {
    const SENDS = [
      {
        kind: "a deduplicated GET",
        send: (client: ApiClient) => client.getPersonalBooks(USER),
      },
      {
        kind: "a POST",
        send: (client: ApiClient) => client.lookupUser(USER),
      },
    ];
    const STORAGE_AFTER_SWITCH = [
      { state: "storage already on the new server", server: NEW_SERVER },
      { state: "storage still on the old server", server: OLD_SERVER },
    ];
    const CASES = SENDS.flatMap((send) =>
      STORAGE_AFTER_SWITCH.map((storage) => ({ ...send, ...storage })),
    );

    it.each(CASES)(
      "refreshes nowhere and resends nothing for $kind with $state",
      async ({ send, server }) => {
        const response = held();
        const calls = fakeNetwork((call) =>
          call.origin === OLD_SERVER && call.path !== REFRESH_PATH
            ? response.promise
            : ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
        );
        await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
        const client = clientOn(OLD_SERVER);

        const pending = send(client);
        await drain();
        client.setEndpoint(NEW_SERVER);
        client.setAuthToken(NEW_TOKEN);
        await seedStorage({ server, token: NEW_TOKEN });
        response.release(UNAUTHORIZED);
        const result = await pending;
        await drain();

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expectNoRefreshOrJoin(calls);
        expect(callsTo(calls, OLD_SERVER)).toHaveLength(1);
        expect(callsTo(calls, OLD_SERVER)[0].token).toBe(OLD_TOKEN);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
        expectNoCallback(client);
      },
    );

    it("resends nothing when the switch lands while the refreshed token is being written", async () => {
      const calls = fakeNetwork(
        deadTokenRoute(OLD_SERVER, {
          refresh: ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
        }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);
      const localSet = vi.mocked(browser.storage.local.set);
      const storeSet = localSet.getMockImplementation()!;
      localSet.mockImplementationOnce(async (items) => {
        await storeSet(items);
        client.setEndpoint(NEW_SERVER);
        client.setAuthToken(NEW_TOKEN);
      });

      const result = await client.getPersonalBooks(USER);

      expect(result.error?.code).toBe("UNAUTHORIZED");
      expect(callsOn(calls, BOOKS_PATH)).toHaveLength(1);
      expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
    });
  });

  describe("a token in storage from another server", () => {
    const OTHER_SERVERS_RECORD = [
      { name: "that names another server", server: NEW_SERVER },
      { name: "with no endpoint key (official default)", server: undefined },
    ];

    it.each(OTHER_SERVERS_RECORD)(
      "sends no refresh or join to either server on a 401, for a record $name",
      async ({ server }) => {
        const calls = fakeNetwork(deadTokenRoute(OLD_SERVER, {}));
        await seedStorage({
          server,
          token: NEW_TOKEN,
          familyId: NEW_FAMILY,
        });
        const before = await storedRecord();
        const client = clientOn(OLD_SERVER);
        vi.mocked(browser.storage.local.set).mockClear();
        localRemove.mockClear();

        const result = await client.getPersonalBooks(USER);

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expect(calls).toHaveLength(1);
        expect(callsTo(calls, OLD_SERVER)[0].path).toBe(BOOKS_PATH);
        expect(callsTo(calls, OLD_SERVER)[0].token).toBe(OLD_TOKEN);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
        expect(callsTo(calls, DEFAULT_API_ENDPOINT)).toHaveLength(0);
        expect(await storedRecord()).toEqual(before);
        expect(browser.storage.local.set).not.toHaveBeenCalled();
        expect(localRemove).not.toHaveBeenCalled();
        expectNoCallback(client);
      },
    );

    it.each(OTHER_SERVERS_RECORD)(
      "sends nothing from a proactive refresh, for a record $name",
      async ({ server }) => {
        const calls = fakeNetwork(() => BOOKS);
        await seedStorage({
          server,
          token: NEW_TOKEN,
          familyId: NEW_FAMILY,
        });
        await browser.storage.local.set({ [TOKEN_EXPIRES_AT_KEY]: 1 });
        const before = await storedRecord();
        const client = clientOn(OLD_SERVER);

        await expect(client.proactiveRefresh()).resolves.toBe(false);

        expect(calls).toEqual([]);
        expect(await storedRecord()).toEqual(before);
        expectNoCallback(client);
      },
    );

    // A teardown whose storage removal failed: familyId, token and endpoint all survived.
    describe("left behind on a client back on the official default", () => {
      const SELF_HOSTED_TOKEN = "e".repeat(64);

      async function seedLeftBehindRecord(): Promise<void> {
        await seedStorage({
          server: NEW_SERVER,
          token: SELF_HOSTED_TOKEN,
        });
        await browser.storage.local.set({ [TOKEN_EXPIRES_AT_KEY]: 1 });
      }

      it("shows the official server no token, no userId and no familyId on a 401", async () => {
        const calls = fakeNetwork((call) =>
          call.path === `/api/user/${OTHER_USER}/books` ? UNAUTHORIZED : BOOKS,
        );
        await seedLeftBehindRecord();
        const client = clientOn(DEFAULT_API_ENDPOINT, null);

        const result = await client.getPersonalBooks(OTHER_USER);

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expect(calls).toHaveLength(1);
        expect(callsTo(calls, DEFAULT_API_ENDPOINT)).toHaveLength(1);
        const seen = JSON.stringify(calls);
        expect(seen).not.toContain(SELF_HOSTED_TOKEN);
        expect(seen).not.toContain(USER);
        expect(seen).not.toContain(OLD_FAMILY);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
        expectNoCallback(client);
      });

      it("shows the official server nothing from a proactive refresh", async () => {
        const calls = fakeNetwork(() => BOOKS);
        await seedLeftBehindRecord();
        const client = clientOn(DEFAULT_API_ENDPOINT, null);

        await expect(client.proactiveRefresh()).resolves.toBe(false);

        expect(callsTo(calls, DEFAULT_API_ENDPOINT)).toHaveLength(0);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
      });
    });
  });

  describe("a refresh still in flight when the family is torn down", () => {
    const TEARDOWNS = [
      {
        name: "a self-hosted client with its storage cleared",
        server: OLD_SERVER,
        clearStorage: true,
      },
      {
        name: "a self-hosted client whose storage removal failed",
        server: OLD_SERVER,
        clearStorage: false,
      },
      {
        name: "an official client with its storage cleared",
        server: DEFAULT_API_ENDPOINT,
        clearStorage: true,
      },
      {
        name: "an official client whose storage removal failed",
        server: DEFAULT_API_ENDPOINT,
        clearStorage: false,
      },
    ];

    it.each(TEARDOWNS)(
      "writes the late token nowhere for $name",
      async ({ server, clearStorage }) => {
        const refresh = held();
        const calls = fakeNetwork(
          deadTokenRoute(server, { refresh: refresh.promise }),
        );
        await seedStorage({
          server: server === OLD_SERVER ? OLD_SERVER : undefined,
          token: OLD_TOKEN,
        });
        const client = clientOn(server);

        const pending = client.getPersonalBooks(USER);
        await drain();
        expect(callsOn(calls, REFRESH_PATH)).toHaveLength(1);

        client.setAuthToken(null);
        client.setEndpoint(DEFAULT_API_ENDPOINT);
        if (clearStorage) await browser.storage.local.clear();
        const afterTeardown = await storedRecord();
        refresh.release(ok({ token: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }));
        const result = await pending;
        await drain();

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expect(await storedRecord()).toEqual(afterTeardown);
        await client.getPersonalBooks(OTHER_USER);
        client.setEndpoint(server);
        await client.getPersonalBooks(OTHER_USER);
        const afterTheRefresh = calls.slice(-2);
        expect(afterTheRefresh.map(({ origin }) => origin)).toEqual([
          DEFAULT_API_ENDPOINT,
          server,
        ]);
        expect(afterTheRefresh.map(({ token }) => token)).toEqual([
          undefined,
          undefined,
        ]);
        expectNoCallback(client);
      },
    );
  });

  describe("a late response after the client or storage moved on", () => {
    const LATE_REPLIES = [
      {
        stage: "refresh",
        reply: "a token",
        answer: ok({ token: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }),
      },
      { stage: "refresh", reply: "a failure", answer: REFRESH_FAILED },
      {
        stage: "join",
        reply: "a token",
        answer: ok({ authToken: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }),
      },
      {
        stage: "join",
        reply: "MEMBER_REMOVED",
        answer: refused(403, "MEMBER_REMOVED"),
      },
      {
        stage: "join",
        reply: "FAMILY_NOT_FOUND",
        answer: refused(404, "FAMILY_NOT_FOUND"),
      },
      {
        stage: "join",
        reply: "VERIFICATION_REQUIRED",
        answer: refused(403, "VERIFICATION_REQUIRED"),
      },
      {
        stage: "join",
        reply: "RATE_LIMITED",
        answer: refused(429, "RATE_LIMITED"),
      },
    ];
    const CASES = LATE_REPLIES.flatMap((reply) =>
      INTERLEAVINGS.map((interleaving) => ({ ...reply, ...interleaving })),
    );

    it.each(CASES)(
      "$stage answering $reply changes nothing after $name",
      async ({ stage, answer, apply, switchedServer }) => {
        const pendingAnswer = held();
        const calls = fakeNetwork(
          deadTokenRoute(
            OLD_SERVER,
            stage === "refresh"
              ? { refresh: pendingAnswer.promise }
              : { join: pendingAnswer.promise },
          ),
        );
        await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
        const client = clientOn(OLD_SERVER);

        const pending = client.getPersonalBooks(USER);
        await drain();
        await apply(client);
        const afterInterleaving = await storedRecord();
        pendingAnswer.release(answer);
        const result = await pending;
        await drain();

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expect(await storedRecord()).toEqual(afterInterleaving);
        expectNoCallback(client);
        // The dropped response was never retried, and the hostile token reached no one.
        expect(callsOn(calls, BOOKS_PATH)).toHaveLength(1);
        expect(callsOn(calls, "/join")).toHaveLength(stage === "join" ? 1 : 0);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);

        await client.getPersonalBooks(OTHER_USER);
        const next = calls[calls.length - 1];
        expect(next.origin).toBe(switchedServer);
        expect(next.token).not.toBe(HOSTILE_TOKEN);
      },
    );

    it("keeps the new server's token on the client after a late token from the old one", async () => {
      const refresh = held();
      const calls = fakeNetwork(
        deadTokenRoute(OLD_SERVER, { refresh: refresh.promise }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const pending = client.getPersonalBooks(USER);
      await drain();
      await INTERLEAVINGS[0].apply(client);
      refresh.release(ok({ token: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }));
      await pending;

      await client.getPersonalBooks(OTHER_USER);
      const onNewServer = callsTo(calls, NEW_SERVER);
      expect(onNewServer).toHaveLength(1);
      expect(onNewServer[0].token).toBe(NEW_TOKEN);
      expect(await storedToken()).toBe(NEW_TOKEN);
    });

    it("drops a late token when the storage re-read itself fails", async () => {
      const refresh = held();
      const calls = fakeNetwork(
        deadTokenRoute(OLD_SERVER, { refresh: refresh.promise }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const before = await storedRecord();
      const client = clientOn(OLD_SERVER);

      const pending = client.getPersonalBooks(USER);
      await drain();
      localGet.mockRejectedValueOnce(new Error("storage unavailable"));
      refresh.release(ok({ token: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }));
      const result = await pending;

      expect(result.error?.code).toBe("UNAUTHORIZED");
      expect(await storedRecord()).toEqual(before);
      expect(callsOn(calls, "/join")).toEqual([]);
      expectNoCallback(client);
    });
  });

  describe("a switch between a failed refresh and its recovery join", () => {
    const WINDOWS = [
      {
        window: "the token removal",
        arm: (effect: () => Promise<void>) =>
          duringRemovalOf(AUTH_TOKEN_KEY, effect),
      },
      {
        window: "the departure-mark read",
        arm: (effect: () => Promise<void>) =>
          duringReadOf(SELF_DEPARTURE_UNTIL_KEY, effect),
      },
      {
        window: "the cooldown read",
        arm: (effect: () => Promise<void>) =>
          duringReadOf(RECOVERY_COOLDOWN_UNTIL_KEY, effect),
      },
    ];
    const CASES = WINDOWS.flatMap((window) =>
      INTERLEAVINGS.map((interleaving) => ({ ...window, ...interleaving })),
    );

    it.each(CASES)(
      "sends the join to neither server when $name during $window",
      async ({ arm, apply }) => {
        const calls = fakeNetwork(
          deadTokenRoute(OLD_SERVER, {
            join: ok({ authToken: HOSTILE_TOKEN, expiresAt: EXPIRES_AT }),
          }),
        );
        await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
        const client = clientOn(OLD_SERVER);
        let afterInterleaving: Record<string, unknown> = {};
        arm(async () => {
          await apply(client);
          afterInterleaving = await storedRecord();
        });

        const result = await client.getPersonalBooks(USER);
        await drain();

        expect(result.error?.code).toBe("UNAUTHORIZED");
        expect(afterInterleaving).toHaveProperty(USER_ID_KEY, USER);
        expect(callsOn(calls, REFRESH_PATH)).toHaveLength(1);
        expect(callsOn(calls, "/join")).toEqual([]);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(0);
        expect(await storedRecord()).toEqual(afterInterleaving);
        expectNoCallback(client);
      },
    );
  });

  describe("a token held in memory when the endpoint changes", () => {
    const SENDS = [
      {
        name: "a read",
        send: (client: ApiClient) => client.getPersonalBooks(USER),
      },
      {
        name: "a join",
        send: (client: ApiClient) => client.joinFamily(NEW_FAMILY, USER),
      },
      {
        name: "a family create",
        send: (client: ApiClient) => client.createFamily(USER, "Me"),
      },
    ];

    it.each(SENDS)(
      "goes to the issuing server but not to the next one, for $name",
      async ({ send }) => {
        const calls = fakeNetwork(() => ok({}));
        const client = clientOn(OLD_SERVER);

        await send(client);
        client.setEndpoint(NEW_SERVER);
        await send(client);

        expect(callsTo(calls, OLD_SERVER)).toHaveLength(1);
        expect(callsTo(calls, OLD_SERVER)[0].token).toBe(OLD_TOKEN);
        expect(callsTo(calls, NEW_SERVER)).toHaveLength(1);
        expect(callsTo(calls, NEW_SERVER)[0].token).toBeUndefined();
      },
    );
  });

  describe("a refresh that never answers", () => {
    it("does not take the first request on the next server down with it", async () => {
      const stuck = held();
      const calls = fakeNetwork((call) => {
        if (call.origin === OLD_SERVER) {
          return call.path === REFRESH_PATH ? stuck.promise : UNAUTHORIZED;
        }
        if (call.path === REFRESH_PATH) {
          return ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT });
        }
        return call.token === FRESH_TOKEN ? BOOKS : UNAUTHORIZED;
      });
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const hung = client.getPersonalBooks(USER);
      await drain();
      await INTERLEAVINGS[0].apply(client);
      let settled = false;
      const next = client.getPersonalBooks(USER).finally(() => {
        settled = true;
      });
      await drain();

      expect(settled).toBe(true);
      await expect(next).resolves.toMatchObject({
        data: { userId: USER, books: [] },
      });
      const onNewServer = callsTo(calls, NEW_SERVER);
      expect(onNewServer.map(({ path }) => path)).toEqual([
        BOOKS_PATH,
        REFRESH_PATH,
        BOOKS_PATH,
      ]);
      expect(onNewServer[0].token).toBe(NEW_TOKEN);
      expect(onNewServer[2].token).toBe(FRESH_TOKEN);

      stuck.release(REFRESH_FAILED);
      await expect(hung).resolves.toMatchObject({
        error: { code: "UNAUTHORIZED" },
      });
    });

    it("releases on setAuthToken(null) alone, with the server unchanged", async () => {
      const stuck = held();
      let refreshes = 0;
      const calls = fakeNetwork((call) => {
        if (call.path === REFRESH_PATH) {
          refreshes += 1;
          return refreshes === 1
            ? stuck.promise
            : ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT });
        }
        return call.token === FRESH_TOKEN ? BOOKS : UNAUTHORIZED;
      });
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const hung = client.getPersonalBooks(USER);
      await drain();
      client.setAuthToken(null);
      let settled = false;
      const next = client.getPersonalBooks(OTHER_USER).finally(() => {
        settled = true;
      });
      await drain();

      expect(settled).toBe(true);
      await expect(next).resolves.toMatchObject({ data: { books: [] } });
      expect(callsOn(calls, REFRESH_PATH)).toHaveLength(2);

      stuck.release(REFRESH_FAILED);
      await hung;
    });

    it("cannot clear the refresh that replaced it when it finally answers", async () => {
      const stuck = held();
      const replacement = held();
      const calls = fakeNetwork((call) => {
        if (call.origin === OLD_SERVER) {
          return call.path === REFRESH_PATH ? stuck.promise : UNAUTHORIZED;
        }
        if (call.path === REFRESH_PATH) return replacement.promise;
        return call.token === FRESH_TOKEN ? BOOKS : UNAUTHORIZED;
      });
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const hung = client.getPersonalBooks(USER);
      await drain();
      await INTERLEAVINGS[0].apply(client);
      const first = client.getPersonalBooks(USER);
      await drain();
      stuck.release(REFRESH_FAILED);
      await hung;
      const second = client.getPersonalBooks(OTHER_USER);
      await drain();

      // Still one: the second 401 shares the live refresh.
      expect(callsOn(callsTo(calls, NEW_SERVER), REFRESH_PATH)).toHaveLength(1);

      replacement.release(ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT }));
      await expect(first).resolves.toMatchObject({ data: { books: [] } });
      await expect(second).resolves.toMatchObject({ data: { books: [] } });
    });
  });

  describe("a rotated token from setVerifyMethod", () => {
    const VERIFY_PATH = `/api/user/${USER}/verify`;
    const ROTATED = ok({
      method: "pin",
      prompted: 1,
      authToken: HOSTILE_TOKEN,
      expiresAt: EXPIRES_AT,
    });

    function holdVerify() {
      const response = held();
      const calls = fakeNetwork((call) =>
        call.path === VERIFY_PATH ? response.promise : BOOKS,
      );
      return { response, calls };
    }

    it("is dropped when the response lands after a switch", async () => {
      const { response, calls } = holdVerify();
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const saving = saveVerifyMethod(client, USER, "pin", "123456");
      await drain();
      await INTERLEAVINGS[0].apply(client);
      const afterSwitch = await storedRecord();
      response.release(ROTATED);
      const result = await saving;

      expect(result.data).toEqual({ method: "pin", prompted: 1 });
      expect(await storedRecord()).toEqual(afterSwitch);

      await client.getPersonalBooks(USER);
      const onNewServer = callsTo(calls, NEW_SERVER);
      expect(onNewServer).toHaveLength(1);
      expect(onNewServer[0].token).toBe(NEW_TOKEN);
    });

    it("is adopted and stored when the client stayed put", async () => {
      const { response, calls } = holdVerify();
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      const saving = saveVerifyMethod(client, USER, "pin", "123456");
      await drain();
      response.release(ROTATED);
      const result = await saving;

      expect(result.data?.authToken).toBe(HOSTILE_TOKEN);
      expect(result.data?.expiresAt).toBe(EXPIRES_AT);
      expect(await storedToken()).toBe(HOSTILE_TOKEN);

      await client.getPersonalBooks(USER);
      expect(calls[calls.length - 1].token).toBe(HOSTILE_TOKEN);
    });
  });

  // See the header → "Normal path cases".
  describe("same-server recovery", () => {
    const SERVERS = [
      {
        name: "a self-hosted client with its endpoint stored",
        server: OLD_SERVER,
        storedEndpoint: OLD_SERVER,
      },
      {
        name: "an official client with no endpoint key",
        server: DEFAULT_API_ENDPOINT,
        storedEndpoint: undefined,
      },
    ];

    it.each(SERVERS)(
      "401 → refresh → resend with the new token, for $name",
      async ({ server, storedEndpoint }) => {
        const calls = fakeNetwork(
          deadTokenRoute(server, {
            refresh: ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
          }),
        );
        await seedStorage({ server: storedEndpoint, token: OLD_TOKEN });
        const client = clientOn(server);

        const result = await client.getPersonalBooks(USER);

        expect(result.data).toMatchObject({ userId: USER, books: [] });
        expect(calls.map(({ path, token }) => [path, token])).toEqual([
          [BOOKS_PATH, OLD_TOKEN],
          [REFRESH_PATH, OLD_TOKEN],
          [BOOKS_PATH, FRESH_TOKEN],
        ]);
        expect(callsTo(calls, server)).toHaveLength(3);
        const stored = await storedRecord();
        expect(stored[AUTH_TOKEN_KEY]).toBe(FRESH_TOKEN);
        expect(stored[TOKEN_EXPIRES_AT_KEY]).toBe(EXPIRES_AT);
      },
    );

    it.each(SERVERS)(
      "refresh failure → recovery join → resend, for $name",
      async ({ server, storedEndpoint }) => {
        const calls = fakeNetwork(
          deadTokenRoute(server, {
            join: ok({ authToken: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
          }),
        );
        await seedStorage({ server: storedEndpoint, token: OLD_TOKEN });
        const client = clientOn(server);

        const result = await client.getPersonalBooks(USER);

        expect(result.data).toMatchObject({ userId: USER });
        expect(calls.map(({ path }) => path)).toEqual([
          BOOKS_PATH,
          REFRESH_PATH,
          JOIN_PATH,
          BOOKS_PATH,
        ]);
        expect(calls[3].token).toBe(FRESH_TOKEN);
        expect(await storedToken()).toBe(FRESH_TOKEN);
      },
    );

    it("a family-gone code from the client's own server still tears the family down", async () => {
      fakeNetwork(
        deadTokenRoute(OLD_SERVER, { join: refused(403, "MEMBER_REMOVED") }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      await client.getPersonalBooks(USER);

      expect(client.onFamilyRemoved).toHaveBeenCalledWith({
        errorCode: "MEMBER_REMOVED",
      });
      const stored = await storedRecord();
      expect(stored[FAMILY_ID_KEY]).toBeUndefined();
      expect(stored[API_ENDPOINT_KEY]).toBeUndefined();
    });

    it("a verification code from the client's own server still prompts", async () => {
      fakeNetwork(
        deadTokenRoute(OLD_SERVER, {
          join: refused(403, "VERIFICATION_REQUIRED"),
        }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      await client.getPersonalBooks(USER);

      expect(client.onReauthRequired).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "VERIFICATION_REQUIRED" }),
      );
      expect((await storedRecord())[FAMILY_ID_KEY]).toBe(OLD_FAMILY);
    });

    const NOT_A_SESSION_CHANGE = [
      {
        name: "the same token is set again",
        touch: (client: ApiClient) => client.setAuthToken(OLD_TOKEN),
      },
      {
        name: "the same endpoint is set again",
        touch: (client: ApiClient) => client.setEndpoint(OLD_SERVER),
      },
      {
        name: "the same endpoint is set again in another spelling",
        touch: (client: ApiClient) => client.setEndpoint(`${OLD_SERVER}/`),
      },
    ];

    it.each(NOT_A_SESSION_CHANGE)(
      "keeps a refresh in flight when $name",
      async ({ touch }) => {
        const refresh = held();
        const calls = fakeNetwork(
          deadTokenRoute(OLD_SERVER, { refresh: refresh.promise }),
        );
        await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
        const client = clientOn(OLD_SERVER);

        const pending = client.getPersonalBooks(USER);
        await drain();
        touch(client);
        refresh.release(ok({ token: FRESH_TOKEN, expiresAt: EXPIRES_AT }));
        const result = await pending;

        expect(result.data).toMatchObject({ userId: USER });
        expect(calls[calls.length - 1].token).toBe(FRESH_TOKEN);
        expect(await storedToken()).toBe(FRESH_TOKEN);
      },
    );
  });

  // See the header → "Decision on a confirmed switch".
  describe("after a confirmed switch", () => {
    async function confirmSwitch(client: ApiClient): Promise<void> {
      const { result, unmount } = renderHook(() =>
        useEndpointSwitch({
          apiClient: client,
          familyEndpoint: NEW_SERVER,
          membersReady: true,
        }),
      );
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.confirm());
      await act(async () => {
        await drain();
      });
      unmount();
    }

    it("rejoins on the new server with no token, and stores the token it issues", async () => {
      const calls = fakeNetwork(
        deadTokenRoute(NEW_SERVER, {
          join: ok({ authToken: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
        }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      const client = clientOn(OLD_SERVER);

      await confirmSwitch(client);
      const result = await client.getPersonalBooks(USER);

      expect(result.data).toMatchObject({ userId: USER });
      expect(callsTo(calls, OLD_SERVER)).toHaveLength(0);
      expect(
        callsTo(calls, NEW_SERVER).map(({ path, token }) => [path, token]),
      ).toEqual([
        [BOOKS_PATH, undefined],
        [REFRESH_PATH, undefined],
        [JOIN_PATH, undefined],
        [BOOKS_PATH, FRESH_TOKEN],
      ]);
      expect(JSON.stringify(calls)).not.toContain(OLD_TOKEN);
      const stored = await storedRecord();
      expect(stored[AUTH_TOKEN_KEY]).toBe(FRESH_TOKEN);
      expect(stored[API_ENDPOINT_KEY]).toBe(NEW_SERVER);
    });

    it.each(["VERIFICATION_REQUIRED", "VERIFICATION_FAILED"])(
      "asks a pin or pattern user to re-verify on %s",
      async (code) => {
        const calls = fakeNetwork(
          deadTokenRoute(NEW_SERVER, { join: refused(403, code) }),
        );
        await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
        const client = clientOn(OLD_SERVER);

        await confirmSwitch(client);
        await client.getPersonalBooks(USER);

        expect(client.onReauthRequired).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: code }),
        );
        expect(client.onFamilyRemoved).not.toHaveBeenCalled();
        expect(JSON.stringify(calls)).not.toContain(OLD_TOKEN);
        const stored = await storedRecord();
        expect(stored[FAMILY_ID_KEY]).toBe(OLD_FAMILY);
        expect(stored[API_ENDPOINT_KEY]).toBe(NEW_SERVER);
      },
    );

    it("does not let the old server's recovery cooldown block the join on the new one", async () => {
      const calls = fakeNetwork(
        deadTokenRoute(NEW_SERVER, {
          join: ok({ authToken: FRESH_TOKEN, expiresAt: EXPIRES_AT }),
        }),
      );
      await seedStorage({ server: OLD_SERVER, token: OLD_TOKEN });
      await browser.storage.local.set({
        [RECOVERY_COOLDOWN_UNTIL_KEY]: Date.now() + 600_000,
      });
      const client = clientOn(OLD_SERVER);

      await confirmSwitch(client);
      const result = await client.getPersonalBooks(USER);

      expect(result.data).toMatchObject({ userId: USER });
      expect(callsOn(callsTo(calls, NEW_SERVER), "/join")).toHaveLength(1);
      expect((await storedRecord())[RECOVERY_COOLDOWN_UNTIL_KEY]).toBe(
        undefined,
      );
    });
  });
});

describe("storageMatches", () => {
  const CUSTOM = "https://family.example";
  const OTHER = "https://other.example";
  const OFFICIAL = validateEndpointUrl(DEFAULT_API_ENDPOINT);

  beforeEach(async () => {
    await browser.storage.local.clear();
  });

  afterEach(async () => {
    await browser.storage.local.clear();
  });

  const CASES: Array<{
    name: string;
    stored: Record<string, unknown>;
    endpoint: string;
    familyId?: string;
    matches: boolean;
  }> = [
    {
      name: "no key reads as the official default",
      stored: {},
      endpoint: OFFICIAL,
      matches: true,
    },
    {
      name: "no key is not a custom server",
      stored: {},
      endpoint: CUSTOM,
      matches: false,
    },
    {
      name: "the official URL stored as a value equals no key",
      stored: { [API_ENDPOINT_KEY]: DEFAULT_API_ENDPOINT },
      endpoint: OFFICIAL,
      matches: true,
    },
    {
      name: "the same custom server",
      stored: { [API_ENDPOINT_KEY]: CUSTOM },
      endpoint: CUSTOM,
      matches: true,
    },
    {
      name: "the same server in a non-canonical form",
      stored: { [API_ENDPOINT_KEY]: `${CUSTOM}/` },
      endpoint: CUSTOM,
      matches: true,
    },
    {
      name: "another server",
      stored: { [API_ENDPOINT_KEY]: OTHER },
      endpoint: CUSTOM,
      matches: false,
    },
    {
      name: "a custom key is not the official default",
      stored: { [API_ENDPOINT_KEY]: OTHER },
      endpoint: OFFICIAL,
      matches: false,
    },
    {
      name: "an unusable string does not read as the official default",
      stored: { [API_ENDPOINT_KEY]: "not-a-url" },
      endpoint: OFFICIAL,
      matches: false,
    },
    {
      name: "a non-string value matches no server",
      stored: { [API_ENDPOINT_KEY]: 42 },
      endpoint: CUSTOM,
      matches: false,
    },
    {
      name: "the same server and family",
      stored: { [API_ENDPOINT_KEY]: CUSTOM, [FAMILY_ID_KEY]: OLD_FAMILY },
      endpoint: CUSTOM,
      familyId: OLD_FAMILY,
      matches: true,
    },
    {
      name: "the same server, another family",
      stored: { [API_ENDPOINT_KEY]: CUSTOM, [FAMILY_ID_KEY]: NEW_FAMILY },
      endpoint: CUSTOM,
      familyId: OLD_FAMILY,
      matches: false,
    },
    {
      name: "the same server, no family stored",
      stored: { [API_ENDPOINT_KEY]: CUSTOM },
      endpoint: CUSTOM,
      familyId: OLD_FAMILY,
      matches: false,
    },
    {
      name: "another server, the same family",
      stored: { [API_ENDPOINT_KEY]: OTHER, [FAMILY_ID_KEY]: OLD_FAMILY },
      endpoint: CUSTOM,
      familyId: OLD_FAMILY,
      matches: false,
    },
    {
      name: "an unusable endpoint, the same family",
      stored: { [API_ENDPOINT_KEY]: "not-a-url", [FAMILY_ID_KEY]: OLD_FAMILY },
      endpoint: OFFICIAL,
      familyId: OLD_FAMILY,
      matches: false,
    },
    {
      name: "no family asked for ignores the stored one",
      stored: { [API_ENDPOINT_KEY]: CUSTOM, [FAMILY_ID_KEY]: NEW_FAMILY },
      endpoint: CUSTOM,
      matches: true,
    },
  ];

  it.each(CASES)("$name", async ({ stored, endpoint, familyId, matches }) => {
    await browser.storage.local.set(stored);

    expect(await storageMatches(endpoint, familyId)).toBe(matches);
  });

  it("rejects when storage cannot be read, so the caller decides", async () => {
    localGet.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(storageMatches(CUSTOM)).rejects.toThrow("storage unavailable");
  });
});

describe("resolveStoredEndpoint", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
  });

  it("reads a missing key as the official default", () => {
    expect(resolveStoredEndpoint(undefined)).toBe(
      validateEndpointUrl(DEFAULT_API_ENDPOINT),
    );
  });

  it.each([
    ["a trailing slash", "https://family.example/"],
    ["several trailing slashes", "https://family.example///"],
    ["an uppercase host", "https://FAMILY.Example"],
    ["surrounding whitespace", "  https://family.example  "],
    ["the bare form", "https://family.example"],
  ])("resolves %s to the client's canonical form", (_label, raw) => {
    const resolved = resolveStoredEndpoint(raw);

    expect(resolved).toBe("https://family.example");
    expect(resolved).toBe(new ApiClient(raw).getEndpoint());
  });

  const UNUSABLE: Array<[string, unknown]> = [
    ["null", null],
    ["a number", 42],
    ["a boolean", true],
    ["an object", { url: "https://family.example" }],
    ["an array", ["https://family.example"]],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["a value that is not a URL", "not-a-url"],
    ["plain HTTP on a public host", "http://evil.example.com"],
    ["embedded credentials", "https://real.example@evil.com"],
    ["a script URL", "javascript:alert(1)"],
  ];

  it.each(UNUSABLE)("matches no server for %s", (_label, raw) => {
    expect(resolveStoredEndpoint(raw)).toBeNull();
  });

  it.each(UNUSABLE)(
    "sends no refresh or join on a 401 when the stored endpoint is %s",
    async (_label, raw) => {
      const calls = fakeNetwork(deadTokenRoute(DEFAULT_API_ENDPOINT, {}));
      await browser.storage.local.set({
        [USER_ID_KEY]: USER,
        [FAMILY_ID_KEY]: OLD_FAMILY,
        [AUTH_TOKEN_KEY]: OLD_TOKEN,
        [API_ENDPOINT_KEY]: raw,
      });
      const before = await storedRecord();
      const client = clientOn(DEFAULT_API_ENDPOINT, null);

      const result = await client.getPersonalBooks(USER);

      expect(result.error?.code).toBe("UNAUTHORIZED");
      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBeUndefined();
      expectNoRefreshOrJoin(calls);
      expect(await storedRecord()).toEqual(before);
      expectNoCallback(client);
    },
  );
});
