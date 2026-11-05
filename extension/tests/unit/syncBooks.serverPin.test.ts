import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `syncBooks` on a pinned server (#457): once the endpoint moves, nothing else
 * of this sync reaches any server, and no later server receives the book list.
 *
 * Real code end to end: `pinSyncApi`, `ApiClient`, merge, breaker, upload and
 * auto-return. Stubbed: `fetch`, which records what each server received and
 * answers like the Worker, and the DOM scraper. The endpoint moves from inside
 * the stubbed `fetch` or scrape, so a move lands while that step is in flight,
 * as a family teardown or a confirmed endpoint switch would.
 *
 * Two kinds of move, per the callers of `setEndpoint`: a teardown goes back to
 * the official server and clears the token; a confirmed switch goes to another
 * server B and keeps it.
 *
 * Positive companions: "while the endpoint does not move" runs the same steps
 * through to the end, including the paths the stops depend on (409 re-read,
 * PATCH), so the "not sent" assertions cannot pass because a step never ran.
 *
 * Not covered on purpose: a token refresh in flight while the endpoint moves.
 * Issue #456 changes that behaviour.
 */

// Only the DOM boundary; everything between the scrape and fetch runs for real.
vi.mock("@/content/scraper", () => ({
  scrapeLibrary: vi.fn(),
  scrapeArchivedBooks: vi.fn(),
}));

import { syncBooks } from "@/sync/syncBooks";
import { pinSyncApi, SYNC_SERVER_CHANGED_MESSAGE } from "@/sync/pinnedSyncApi";
import { scrapeLibrary, type ScrapeResult } from "@/content/scraper";
import { NAV_SETTLE_MS } from "@/content/hashNavigation";
import {
  ApiClient,
  BoolFlag,
  BorrowStatus,
  PERSONAL_BOOKS_SCHEMA_VERSION,
  type BorrowRequest,
} from "@/api/client";
import {
  AUTH_TOKEN_KEY,
  DEFAULT_API_ENDPOINT,
  FAMILY_ID_KEY,
  LAST_SYNC_AT_KEY,
  USER_ID_KEY,
} from "@/constants";
import { BOOKS_CONFLICT_CODE } from "moo-family-bookshelf-shared/personal/saveErrors";

const USER_ID = "user-123";
const FAMILY_ID = "fam-1";
const BOOK_ID = "210000000000001";
const REQUEST_ID = "req-1";
const SELF_HOSTED = "https://self-hosted.example";
const SERVER_B = "https://server-b.example";
const OFFICIAL = DEFAULT_API_ENDPOINT;
const OLD_TOKEN = "a".repeat(64);
const NEW_TOKEN = "b".repeat(64);
const START_HASH = "#/settings";

const BOOKS_PATH = `/api/user/${USER_ID}/books`;
const BORROW_PATH = `/api/family/${FAMILY_ID}/borrow`;
const RETURN_PATH = `/api/borrow/${REQUEST_ID}`;
const REFRESH_PATH = "/api/auth/refresh";

const GET_BOOKS = `GET ${BOOKS_PATH}`;
const PUT_BOOKS = `PUT ${BOOKS_PATH}`;
const GET_BORROW = `GET ${BORROW_PATH}`;
const PATCH_RETURN = `PATCH ${RETURN_PATH}`;
const POST_REFRESH = `POST ${REFRESH_PATH}`;

const SCRAPE: ScrapeResult = {
  books: [
    {
      bookId: BOOK_ID,
      title: "書",
      author: "作者",
      coverUrl: "",
      readmooUrl: `https://readmoo.com/book/${BOOK_ID}`,
      category: "",
    },
  ],
  complete: true,
  libraryIds: null,
};

const RECORD = {
  schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
  userId: USER_ID,
  displayName: "",
  lastUpdated: "2026-01-01T00:00:00.000Z",
  books: [
    {
      ...SCRAPE.books[0],
      isbn: "",
      isShared: BoolFlag.TRUE,
      isArchived: BoolFlag.FALSE,
    },
  ],
};

// Lent long ago and back in the scrape, so a finished sync marks it RETURNED.
const LENT_REQUEST: BorrowRequest = {
  requestId: REQUEST_ID,
  familyId: FAMILY_ID,
  borrowerId: "user-2",
  borrowerName: "借書人",
  ownerId: USER_ID,
  bookId: BOOK_ID,
  bookTitle: "書",
  bookAuthor: "",
  bookCoverUrl: "",
  status: BorrowStatus.LENT,
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

const CONFLICT = {
  status: 409,
  body: { error: { code: BOOKS_CONFLICT_CODE, message: "conflict" } },
};
const UNAUTHORIZED = {
  status: 401,
  body: { error: { code: "UNAUTHORIZED", message: "expired" } },
};

interface Received {
  server: string;
  route: string;
  authorization: string | undefined;
}
type Reply = { status: number; body: unknown };

/** What the Worker answers when a test scripted nothing else for the route. */
function defaultReply(route: string): Reply {
  const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
  switch (route) {
    case GET_BOOKS:
      return ok(RECORD);
    case PUT_BOOKS:
      return ok({ ...RECORD, lastUpdated: "2026-01-02T00:00:00.000Z" });
    case GET_BORROW:
      return ok([LENT_REQUEST]);
    case PATCH_RETURN:
      return ok({ ...LENT_REQUEST, status: BorrowStatus.RETURNED });
    case POST_REFRESH:
      return ok({ token: NEW_TOKEN, expiresAt: Date.now() + 3_600_000 });
    default:
      throw new Error(`Unexpected request: ${route}`);
  }
}

// Each move a sync can meet. See the header.
const MOVES = [
  {
    move: "a family teardown to the official server",
    target: OFFICIAL,
    clearToken: true,
  },
  {
    move: "a confirmed switch to server B",
    target: SERVER_B,
    clearToken: false,
  },
];

describe("syncBooks on a pinned server", () => {
  let client: ApiClient;
  let received: Received[];
  let originalHash: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let triggers: Array<{ route: string; nth: number; act: () => void }>;
  let scriptedReplies: Array<{ route: string; reply: Reply }>;

  /** Run `act` while the `nth` request for `route` is in flight. */
  function during(route: string, act: () => void, nth = 1): void {
    triggers.push({ route, nth, act });
  }

  /** Answer the next request for `route` with `reply` instead of the default. */
  function replyOnce(route: string, reply: Reply): void {
    scriptedReplies.push({ route, reply });
  }

  function moveEndpoint(target: string, clearToken: boolean): void {
    client.setEndpoint(target);
    if (clearToken) client.setAuthToken(null);
  }

  function handleFetch(url: string, init?: RequestInit): Response {
    const { origin, pathname } = new URL(url);
    const route = `${init?.method ?? "GET"} ${pathname}`;
    const headers = init?.headers as Record<string, string> | undefined;
    received.push({
      server: origin,
      route,
      authorization: headers?.Authorization,
    });
    const nth = received.filter((r) => r.route === route).length;
    triggers
      .filter((t) => t.route === route && t.nth === nth)
      .forEach((t) => t.act());
    const scripted = scriptedReplies.findIndex((s) => s.route === route);
    const { status, body } =
      scripted === -1
        ? defaultReply(route)
        : scriptedReplies.splice(scripted, 1)[0].reply;
    return new Response(JSON.stringify(body), { status });
  }

  /** Start the sync the way the Dialog does: pinned when triggered, from another hash. */
  async function runSync() {
    const pending = syncBooks({
      navigate: true,
      userId: USER_ID,
      familyId: FAMILY_ID,
      apiClient: pinSyncApi(client),
    });
    await vi.advanceTimersByTimeAsync(NAV_SETTLE_MS);
    return pending;
  }

  const trail = () => received.map((r) => r.route);
  const sentTo = (server: string) =>
    received.filter((r) => r.server === server);
  const lastSyncAt = async () =>
    (await chrome.storage.local.get(LAST_SYNC_AT_KEY))[LAST_SYNC_AT_KEY];

  function expectStopped(
    result: Awaited<ReturnType<typeof syncBooks>>,
    target: string,
  ): void {
    expect(sentTo(target)).toEqual([]);
    expect(result).toEqual({
      success: false,
      books: [],
      error: SYNC_SERVER_CHANGED_MESSAGE,
    });
    expect(window.location.hash).toBe(START_HASH);
  }

  beforeEach(async () => {
    received = [];
    triggers = [];
    scriptedReplies = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => handleFetch(url, init)),
    );
    vi.mocked(scrapeLibrary).mockReset();
    vi.mocked(scrapeLibrary).mockResolvedValue(SCRAPE);

    originalHash = window.location.hash;
    window.location.hash = START_HASH;

    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER_ID,
      [FAMILY_ID_KEY]: FAMILY_ID,
      [AUTH_TOKEN_KEY]: OLD_TOKEN,
    });
    client = new ApiClient(SELF_HOSTED);
    client.setAuthToken(OLD_TOKEN);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
    window.location.hash = originalHash;
    await chrome.storage.local.clear();
  });

  describe.each(MOVES)("after $move", ({ target, clearToken }) => {
    it("sends no PUT when the endpoint moves during the borrow-list GET", async () => {
      during(GET_BORROW, () => moveEndpoint(target, clearToken));

      const result = await runSync();

      expectStopped(result, target);
      expect(trail()).toEqual([GET_BOOKS, GET_BOOKS, GET_BORROW]);
      expect(await lastSyncAt()).toBeUndefined();
    });

    it("stops at the borrow-list call when the endpoint moves during the read before it", async () => {
      during(GET_BOOKS, () => moveEndpoint(target, clearToken), 2);

      const result = await runSync();

      expectStopped(result, target);
      expect(trail()).toEqual([GET_BOOKS, GET_BOOKS]);
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Borrow list unavailable"),
        expect.anything(),
      );
      expect(await lastSyncAt()).toBeUndefined();
    });

    it("sends nothing after the first read when the endpoint moves during the scrape", async () => {
      vi.mocked(scrapeLibrary).mockImplementation(async () => {
        moveEndpoint(target, clearToken);
        return SCRAPE;
      });

      const result = await runSync();

      expect(scrapeLibrary).toHaveBeenCalledOnce();
      expectStopped(result, target);
      // Only the read from before the move: the moved-to server learns no id at all.
      expect(trail()).toEqual([GET_BOOKS]);
      expect(received[0].server).toBe(SELF_HOSTED);
      expect(received[0].route).toContain(USER_ID);
      expect(trail().join()).not.toContain(FAMILY_ID);
      expect(await lastSyncAt()).toBeUndefined();
    });

    it("neither re-reads nor re-sends when the endpoint moves during the PUT that gets a 409", async () => {
      during(PUT_BOOKS, () => moveEndpoint(target, clearToken));
      replyOnce(PUT_BOOKS, CONFLICT);

      const result = await runSync();

      expectStopped(result, target);
      expect(trail()).toEqual([GET_BOOKS, GET_BOOKS, GET_BORROW, PUT_BOOKS]);
      expect(await lastSyncAt()).toBeUndefined();
    });

    it("does not re-send when the endpoint moves during the re-read after a 409", async () => {
      replyOnce(PUT_BOOKS, CONFLICT);
      during(GET_BOOKS, () => moveEndpoint(target, clearToken), 3);

      const result = await runSync();

      expectStopped(result, target);
      expect(trail()).toEqual([
        GET_BOOKS,
        GET_BOOKS,
        GET_BORROW,
        PUT_BOOKS,
        GET_BOOKS,
      ]);
      expect(await lastSyncAt()).toBeUndefined();
    });

    it("skips the return PATCH and still succeeds when the endpoint moves after the upload landed", async () => {
      during(PUT_BOOKS, () => moveEndpoint(target, clearToken));

      const result = await runSync();

      expect(sentTo(target)).toEqual([]);
      expect(trail()).toEqual([GET_BOOKS, GET_BOOKS, GET_BORROW, PUT_BOOKS]);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.autoReturnedRequestIds).toEqual([]);
      expect(window.location.hash).toBe(START_HASH);
      expect(await lastSyncAt()).toEqual(expect.any(Number));
    });
  });

  describe("while the endpoint does not move", () => {
    it("runs every step on the pinned server through to the return PATCH", async () => {
      const result = await runSync();

      expect(trail()).toEqual([
        GET_BOOKS,
        GET_BOOKS,
        GET_BORROW,
        PUT_BOOKS,
        PATCH_RETURN,
      ]);
      expect(sentTo(SELF_HOSTED)).toHaveLength(5);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.books.map((b) => b.bookId)).toEqual([BOOK_ID]);
      expect(result.autoReturnedRequestIds).toEqual([REQUEST_ID]);
      expect(window.location.hash).toBe(START_HASH);
      expect(await lastSyncAt()).toEqual(expect.any(Number));
    });

    it("re-reads and re-sends after a 409", async () => {
      replyOnce(PUT_BOOKS, CONFLICT);

      const result = await runSync();

      expect(trail()).toEqual([
        GET_BOOKS,
        GET_BOOKS,
        GET_BORROW,
        PUT_BOOKS,
        GET_BOOKS,
        PUT_BOOKS,
        PATCH_RETURN,
      ]);
      expect(sentTo(SELF_HOSTED)).toHaveLength(7);
      expect(result.success).toBe(true);
    });

    it.each([
      {
        step: "the first read",
        route: GET_BOOKS,
        expectedTrail: [
          GET_BOOKS,
          POST_REFRESH,
          GET_BOOKS,
          GET_BOOKS,
          GET_BORROW,
          PUT_BOOKS,
          PATCH_RETURN,
        ],
      },
      {
        step: "the PUT",
        route: PUT_BOOKS,
        expectedTrail: [
          GET_BOOKS,
          GET_BOOKS,
          GET_BORROW,
          PUT_BOOKS,
          POST_REFRESH,
          PUT_BOOKS,
          PATCH_RETURN,
        ],
      },
    ])(
      "is not stopped by a 401 on $step that refreshes and retries on the same server",
      async ({ route, expectedTrail }) => {
        replyOnce(route, UNAUTHORIZED);

        const result = await runSync();

        expect(trail()).toEqual(expectedTrail);
        expect(sentTo(SELF_HOSTED)).toHaveLength(expectedTrail.length);
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        // The retry carries the refreshed token, and so does everything after it.
        expect(received[expectedTrail.length - 1].authorization).toBe(
          `Bearer ${NEW_TOKEN}`,
        );
      },
    );

    it("is not stopped by setEndpoint with the same server in another spelling", async () => {
      during(GET_BORROW, () => client.setEndpoint(`${SELF_HOSTED}/`));

      const result = await runSync();

      expect(sentTo(SELF_HOSTED)).toHaveLength(5);
      expect(result.success).toBe(true);
    });
  });
});
