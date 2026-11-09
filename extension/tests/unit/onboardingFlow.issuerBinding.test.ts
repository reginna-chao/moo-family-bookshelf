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
import {
  decodeSyncCode,
  encodeSyncCode,
} from "moo-family-bookshelf-shared/crypto/syncCode";
import { ApiClient, BoolFlag, type BookEntry } from "@/api/client";
import {
  createNewFamily,
  performJoin,
  performSoloRecovery,
  tryAutoRecovery,
} from "@/dialog/onboardingFlow";
import { encodePersonalBooksCache } from "@/dialog/personalBooksCache";
import type { useAutoSetup } from "@/dialog/useAutoSetup";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  PERSONAL_BOOKS_CACHE_KEY,
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
 * Issue #477: a create / join token belongs to the server the request was sent to,
 * even when the client has moved by the time the flow finishes with it.
 *
 * The only thing that moves a client mid-flow is a family teardown: `onFamilyRemoved`
 * in `App.tsx` runs `client.setAuthToken(null); client.setEndpoint(DEFAULT)`
 * (`familyTreeTeardown.ts`). Before the fix each flow read `getEndpoint()` after the
 * response, and bound the token after the cache migration. A teardown in between
 * paired server B's token with the official server, in storage and in memory, and a
 * sync code lost its `@host`. The migration could trigger that teardown itself: its
 * GET carried no token, so the Worker answered 401 and the refresh path ran.
 *
 * Everything here is real except `fetch`: `ApiClient`, the flows, the migration and
 * the sync code codec, on the shared store from `tests/setup.ts`. `syncBooks` is a
 * mock, so a case's scope ends where the flow returns; what happens after a teardown
 * in `syncBooks` / `onFamilyJoined` is issue #476.
 *
 * `servers` differs from the route in `onboardingFlow.tokenBinding.test.ts`: it looks
 * at the token. A protected path answers a tokenless request with 401, as
 * `worker/src/middleware/auth.ts` does, so "the GET carried no token" is observable.
 *
 * `nextRequestFrom`: the flow's own requests are sampled first, then the client sends
 * one more book-list read and everything from that point on is compared whole. The
 * expected result is one tokenless request to the official server: it proves the
 * request really went out, so the assertion cannot pass on an empty list, and it fails
 * on a token left in memory as well as on a stored pair that lets the refresh path
 * read B's token and send it to the official server. The order of the two stages must
 * not be swapped, or the probe's own request would land in the flow's sample.
 *
 * `officialAcceptsUpload`: the cache case needs an official server that would take the
 * upload. A 401 or 404 makes the migration read the record state as unknown, which
 * keeps the cache anyway, so that assertion could not fail without this route.
 */

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
  });
}

const USER = await deriveUserId("owner@example.com");
const CREATED_FAMILY = "created-1";
const JOINED_FAMILY = "joined-1";

const OFFICIAL = new URL(DEFAULT_API_ENDPOINT).origin;
const SERVER_B = "https://server-b.example";
const OFFICIAL_TOKEN = "a".repeat(64);
const B_TOKEN = "b".repeat(64);
const REFRESHED_TOKEN = "c".repeat(64);
const EXPIRES_AT = 9_999_999_999_999;

const BOOKS_PATH = `/api/user/${USER}/books`;
const REFRESH_PATH = "/api/auth/refresh";

/** See the header → "`nextRequestFrom`". */
const TOKENLESS_TO_OFFICIAL = [[OFFICIAL, BOOKS_PATH, undefined]];

const issuesToken = (call: Call) =>
  (call.method === "POST" && call.path === "/api/family") ||
  call.path.endsWith("/join");

const issue = (familyId: string, origin: string) =>
  ok({
    familyId,
    authToken: origin === OFFICIAL ? OFFICIAL_TOKEN : B_TOKEN,
    expiresAt: EXPIRES_AT,
  });

type Server = (call: Call) => Reply;

/** See the header → "`servers`". */
const servers: Server = (call) => {
  if (call.method === "POST" && call.path === "/api/family") {
    return issue(CREATED_FAMILY, call.origin);
  }
  if (call.path.endsWith("/join")) return issue(JOINED_FAMILY, call.origin);
  if (call.token === undefined) return refused(401, "UNAUTHORIZED");
  if (call.path === BOOKS_PATH) return ok({ userId: USER, books: [] });
  if (call.path === REFRESH_PATH) {
    return ok({ token: REFRESHED_TOKEN, expiresAt: EXPIRES_AT });
  }
  if (call.path.endsWith("/endpoint")) return ok({ ok: true });
  return refused(404, "NOT_FOUND");
};

const isMigrationGet = (call: Call) =>
  call.origin === SERVER_B && call.method === "GET" && call.path === BOOKS_PATH;

/** The held migration GET gets an answer on release, whatever token it carried. */
const answersMigrationGet: Server = (call) =>
  isMigrationGet(call) ? ok({ userId: USER, books: [] }) : servers(call);

/** See the header → "`officialAcceptsUpload`". */
const officialAcceptsUpload: Server = (call) => {
  if (call.origin === OFFICIAL && call.path === BOOKS_PATH) {
    return call.method === "GET" ? ok(null) : ok({ ok: true });
  }
  return servers(call);
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

const startCreate = (apiClient: ApiClient) =>
  createNewFamily({ ...IDENTITY, apiClient });

const FLOWS: Array<{
  flow: string;
  run: (apiClient: ApiClient) => Promise<unknown>;
}> = [
  { flow: "createNewFamily", run: startCreate },
  {
    flow: "performJoin with a code carrying no @host",
    run: (apiClient) =>
      performJoin({
        ...IDENTITY,
        apiClient,
        syncCodeInput: `moo-${JOINED_FAMILY}`,
      }),
  },
  {
    flow: "tryAutoRecovery",
    run: (apiClient) => tryAutoRecovery(recoveryOpts(apiClient)),
  },
  {
    flow: "performSoloRecovery",
    run: (apiClient) => performSoloRecovery(recoveryOpts(apiClient)),
  },
];

const CACHED_BOOK: BookEntry = {
  bookId: "210439468000101",
  title: "測試書籍",
  author: "作者",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared: BoolFlag.FALSE,
};
const CACHE = encodePersonalBooksCache(USER, [CACHED_BOOK]);

type StorageWrite = Mock<(arg: unknown) => Promise<void>>;
const localSet = browser.storage.local.set as unknown as StorageWrite;
const localRemove = browser.storage.local.remove as unknown as StorageWrite;
const storeSet = localSet.getMockImplementation()!;
const storeRemove = localRemove.getMockImplementation()!;
const syncSet = browser.storage.sync.set as unknown as StorageWrite;
const storeSyncSet = syncSet.getMockImplementation()!;

/** Run `effect` once, right after the next local storage write takes hold. */
function afterFirstWrite(effect: () => void): void {
  let fired = false;
  const firing =
    (store: (arg: unknown) => Promise<void>) => async (arg: unknown) => {
      await store(arg);
      if (fired) return;
      fired = true;
      effect();
    };
  localSet.mockImplementation(firing(storeSet));
  localRemove.mockImplementation(firing(storeRemove));
}

/** What `unmountFamilyTreeThenResetClient` does to the live client, in its order. */
function tearDown(client: ApiClient): void {
  client.setAuthToken(null);
  client.setEndpoint(DEFAULT_API_ENDPOINT);
}

async function storedPair(): Promise<unknown[]> {
  const stored = await browser.storage.local.get([
    API_ENDPOINT_KEY,
    AUTH_TOKEN_KEY,
  ]);
  return [stored[API_ENDPOINT_KEY], stored[AUTH_TOKEN_KEY]];
}

async function storedCache(): Promise<unknown> {
  const stored = await browser.storage.local.get([PERSONAL_BOOKS_CACHE_KEY]);
  return stored[PERSONAL_BOOKS_CACHE_KEY];
}

describe("onboarding flows and the server that issued their token", () => {
  const originalFetch = globalThis.fetch;
  let calls: Call[];

  const booksCallsTo = (server: string) =>
    callsTo(calls, server).filter(({ path }) => path === BOOKS_PATH);
  const endpointCalls = () =>
    calls.filter(({ path }) => path.endsWith("/endpoint"));

  /** See the header → "`nextRequestFrom`". */
  async function nextRequestFrom(
    client: ApiClient,
  ): Promise<Array<Array<string | undefined>>> {
    const start = calls.length;
    await client.getPersonalBooks(USER);
    return calls
      .slice(start)
      .map(({ origin, path, token }) => [origin, path, token]);
  }

  /** Start a flow, tear the client down once `isHeld` holds a request, then let it answer. */
  async function tearDownWhileHeld<T>(
    isHeld: (call: Call) => boolean,
    route: Server,
    client: ApiClient,
    start: (client: ApiClient) => Promise<T>,
  ): Promise<T> {
    const gate = held<void>();
    calls = fakeNetwork(async (call) => {
      if (isHeld(call)) await gate.promise;
      return route(call);
    });
    const finished = start(client);
    await vi.waitFor(() => expect(calls.some(isHeld)).toBe(true));
    tearDown(client);
    gate.release();
    const result = await finished;
    await drain();
    return result;
  }

  beforeEach(async () => {
    await browser.storage.local.clear();
    vi.clearAllMocks();
    await browser.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: CACHE });
    calls = fakeNetwork(servers);
  });

  afterEach(async () => {
    localSet.mockImplementation(storeSet);
    localRemove.mockImplementation(storeRemove);
    syncSet.mockImplementation(storeSyncSet);
    globalThis.fetch = originalFetch;
    await browser.storage.local.clear();
    await browser.storage.sync.clear();
  });

  describe("torn down while the create / join request is in flight", () => {
    it.each(FLOWS)(
      "$flow stores B's pair, and sends the official server neither a book read nor B's token",
      async ({ run }) => {
        const client = new ApiClient(SERVER_B);

        await tearDownWhileHeld(issuesToken, servers, client, run);

        expect(await storedPair()).toEqual([SERVER_B, B_TOKEN]);
        expect(booksCallsTo(OFFICIAL)).toEqual([]);
        expect(await nextRequestFrom(client)).toEqual(TOKENLESS_TO_OFFICIAL);
      },
    );

    it.each(FLOWS)(
      "$flow keeps the personal books cache, even if the official server would take it",
      async ({ run }) => {
        await tearDownWhileHeld(
          issuesToken,
          officialAcceptsUpload,
          new ApiClient(SERVER_B),
          run,
        );

        expect(await storedCache()).toBe(CACHE);
      },
    );

    it("createNewFamily still returns a sync code carrying @B", async () => {
      const { syncCode } = await tearDownWhileHeld(
        issuesToken,
        servers,
        new ApiClient(SERVER_B),
        startCreate,
      );

      expect(syncCode).toBe(
        encodeSyncCode({ familyId: CREATED_FAMILY, apiHost: SERVER_B }),
      );
      expect(decodeSyncCode(syncCode).apiHost).toBe(SERVER_B);
    });

    it("performJoin with an @B code on the official client stores B's pair, and B's token stays off the official server", async () => {
      const client = new ApiClient();

      await tearDownWhileHeld(issuesToken, servers, client, (apiClient) =>
        performJoin({
          ...IDENTITY,
          apiClient,
          syncCodeInput: `moo-${JOINED_FAMILY}@${SERVER_B}`,
        }),
      );

      expect([calls[0].origin, calls[0].path]).toEqual([
        SERVER_B,
        `/api/family/${JOINED_FAMILY}/join`,
      ]);
      expect(await storedPair()).toEqual([SERVER_B, B_TOKEN]);
      expect(await nextRequestFrom(client)).toEqual(TOKENLESS_TO_OFFICIAL);
    });
  });

  describe("torn down while the cache migration's GET is held", () => {
    it.each(FLOWS)(
      "$flow never binds B's token to the official server",
      async ({ run }) => {
        const client = new ApiClient(SERVER_B);

        await tearDownWhileHeld(
          isMigrationGet,
          answersMigrationGet,
          client,
          run,
        );

        expect(booksCallsTo(SERVER_B)).toHaveLength(1);
        expect(booksCallsTo(OFFICIAL)).toEqual([]);
        expect(await nextRequestFrom(client)).toEqual(TOKENLESS_TO_OFFICIAL);
      },
    );

    it("createNewFamily sends no endpoint update to anyone", async () => {
      await tearDownWhileHeld(
        isMigrationGet,
        answersMigrationGet,
        new ApiClient(SERVER_B),
        startCreate,
      );

      expect(endpointCalls()).toEqual([]);
    });
  });

  describe("torn down right after the first storage write", () => {
    it.each(FLOWS)(
      "$flow stops before binding, so the official server gets no book read and no token",
      async ({ run }) => {
        const client = new ApiClient(SERVER_B);
        const teardown = vi.fn(() => tearDown(client));
        afterFirstWrite(teardown);

        await run(client);
        await drain();

        expect(teardown).toHaveBeenCalledTimes(1);
        expect(booksCallsTo(OFFICIAL)).toEqual([]);
        expect(await nextRequestFrom(client)).toEqual(TOKENLESS_TO_OFFICIAL);
      },
    );
  });

  describe("torn down right after the sync storage write", () => {
    it.each(FLOWS)("$flow does not bind B's token", async ({ run }) => {
      const client = new ApiClient(SERVER_B);
      const teardown = vi.fn(() => tearDown(client));
      syncSet.mockImplementation(async (arg: unknown) => {
        await storeSyncSet(arg);
        teardown();
      });

      await run(client);
      await drain();

      expect(teardown).toHaveBeenCalledTimes(1);
      expect(await nextRequestFrom(client)).toEqual(TOKENLESS_TO_OFFICIAL);
    });
  });

  describe("with no teardown", () => {
    it.each(FLOWS)(
      "$flow binds before migrating: the first GET carries B's token and nothing refreshes",
      async ({ run }) => {
        await run(new ApiClient(SERVER_B));
        await drain();

        const [firstBooksCall] = booksCallsTo(SERVER_B);
        expect(firstBooksCall.method).toBe("GET");
        expect(firstBooksCall.token).toBe(B_TOKEN);
        expect(calls.filter(({ path }) => path === REFRESH_PATH)).toEqual([]);
      },
    );

    it("createNewFamily sends the endpoint update to B, naming B", async () => {
      await startCreate(new ApiClient(SERVER_B));
      await drain();

      const sent = endpointCalls().map(({ origin, path, body }) => [
        origin,
        path,
        JSON.parse(body ?? "null"),
      ]);
      expect(sent).toEqual([
        [
          SERVER_B,
          `/api/family/${CREATED_FAMILY}/endpoint`,
          { apiEndpoint: SERVER_B },
        ],
      ]);
    });
  });
});
