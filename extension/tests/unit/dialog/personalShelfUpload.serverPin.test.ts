import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadPersonalShelf } from "@/dialog/personalShelfUpload";
import { SyncServerChangedError } from "@/sync/pinnedSyncApi";
import {
  ApiClient,
  BoolFlag,
  PERSONAL_BOOKS_SCHEMA_VERSION,
  type BookEntry,
} from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { BOOKS_CONFLICT_CODE } from "moo-family-bookshelf-shared/personal/saveErrors";

/**
 * `uploadPersonalShelf` on a pinned server (#463): a manual Save's full PUT and
 * its 409 re-read stay on the server the client held when Save was pressed. Once
 * the endpoint moves, the next call is not sent, so the family's full book list
 * never reaches the server the client moved to.
 *
 * Real code end to end: `pinSyncApi`, `ApiClient` and its transport, the shared
 * rebase. Stubbed: `fetch`, which records what each server received and answers
 * like the Worker. A held reply stays open until the test releases it, so the
 * endpoint moves while that request is in flight, as a family teardown or a
 * confirmed endpoint switch would.
 *
 * Positive companions: "the endpoint does not move" runs the 409 path through to
 * the second PUT, so the "not sent" assertions cannot pass because a step never
 * ran. A request that already left is not recalled: it lands on the server it
 * was sent to and counts as saved.
 *
 * PATCH is deliberately not pinned: it is one call with no await before it.
 */

const USER_ID = "user-123";
const FAMILY_SERVER = "https://self-hosted.example";
const OFFICIAL = DEFAULT_API_ENDPOINT;
const A = "210000000000001";
const D = "210000000000002";
const READ_STAMP = "2026-01-01T00:00:00.000Z";
const REREAD_STAMP = "2026-01-02T00:00:00.000Z";
const LANDED_STAMP = "2026-01-03T00:00:00.000Z";

const BOOKS_PATH = `/api/user/${USER_ID}/books`;
const GET_BOOKS = `GET ${BOOKS_PATH}`;
const PUT_BOOKS = `PUT ${BOOKS_PATH}`;
const PATCH_BOOKS = `PATCH ${BOOKS_PATH}`;

const makeBook = (bookId: string, isShared: BoolFlag): BookEntry => ({
  bookId,
  title: `書-${bookId}`,
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared,
});

const LOCAL_BOOKS = [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.TRUE)];
const DIRTY = new Set([D]);

/** A stamp and no `books`: nothing is server-known, so the Save is a full PUT. */
const PUT_RAW = { lastUpdated: READ_STAMP };
/** Every book server-known: the Save is a PATCH of the dirty one. */
const PATCH_RAW = {
  books: [makeBook(A, BoolFlag.TRUE), makeBook(D, BoolFlag.FALSE)],
  lastUpdated: READ_STAMP,
};

interface Reply {
  status: number;
  body: unknown;
}
interface Received {
  server: string;
  route: string;
  body: Record<string, unknown> | undefined;
}

const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
const CONFLICT: Reply = {
  status: 409,
  body: { error: { code: BOOKS_CONFLICT_CODE, message: "conflict" } },
};
const PUT_LANDED = ok({ lastUpdated: LANDED_STAMP });
const REREAD = ok({
  schemaVersion: PERSONAL_BOOKS_SCHEMA_VERSION,
  userId: USER_ID,
  displayName: "",
  books: [makeBook(A, BoolFlag.FALSE), makeBook(D, BoolFlag.FALSE)],
  lastUpdated: REREAD_STAMP,
});

/** What the Worker answers when a test scripted nothing else for the route. */
function defaultReply(route: string): Reply {
  switch (route) {
    case GET_BOOKS:
      return REREAD;
    case PUT_BOOKS:
      return PUT_LANDED;
    case PATCH_BOOKS:
      return ok({ ok: true, applied: 1 });
    default:
      throw new Error(`Unexpected request: ${route}`);
  }
}

describe("uploadPersonalShelf on a pinned server", () => {
  let client: ApiClient;
  let received: Received[];
  let scripted: Array<{ route: string; reply: Reply | Promise<Reply> }>;

  /** Answer the next request for `route` with `reply` instead of the default. */
  function replyOnce(route: string, reply: Reply): void {
    scripted.push({ route, reply });
  }

  /** Keep the next request for `route` open; the returned function answers it. */
  function holdOnce(route: string): (reply: Reply) => void {
    let release: (reply: Reply) => void = () => {};
    const reply = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    scripted.push({ route, reply });
    return (answer) => release(answer);
  }

  async function handleFetch(url: string, init?: RequestInit) {
    const { origin, pathname } = new URL(url);
    const route = `${init?.method ?? "GET"} ${pathname}`;
    received.push({
      server: origin,
      route,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const index = scripted.findIndex((s) => s.route === route);
    const { status, body } = await (index === -1
      ? defaultReply(route)
      : scripted.splice(index, 1)[0].reply);
    return new Response(JSON.stringify(body), { status });
  }

  const upload = (raw: Record<string, unknown>) =>
    uploadPersonalShelf({
      apiClient: client,
      userId: USER_ID,
      displayName: "小明",
      books: LOCAL_BOOKS,
      dirtyBookIds: DIRTY,
      raw,
    });

  const trail = () => received.map((r) => r.route);
  const sentTo = (server: string) =>
    received.filter((r) => r.server === server).map((r) => r.route);
  const rejectionOf = (pending: Promise<unknown>) =>
    pending.then(
      () => null,
      (err: unknown) => err,
    );
  const inFlight = (...routes: string[]) =>
    vi.waitFor(() => expect(trail()).toEqual(routes));

  beforeEach(() => {
    received = [];
    scripted = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handleFetch(url, init)),
    );
    client = new ApiClient(FAMILY_SERVER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("when the endpoint moves mid-save", () => {
    it("does not send the rebased PUT when it moves during the 409 re-read", async () => {
      replyOnce(PUT_BOOKS, CONFLICT);
      const releaseRead = holdOnce(GET_BOOKS);

      const pending = upload(PUT_RAW);
      await inFlight(PUT_BOOKS, GET_BOOKS);
      client.setEndpoint(OFFICIAL);
      releaseRead(REREAD);
      const error = await rejectionOf(pending);

      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS, GET_BOOKS]);
      expect(error).toBeInstanceOf(SyncServerChangedError);
    });

    it("sends no re-read when it moves during the PUT that gets a 409", async () => {
      const releasePut = holdOnce(PUT_BOOKS);

      const pending = upload(PUT_RAW);
      await inFlight(PUT_BOOKS);
      client.setEndpoint(OFFICIAL);
      releasePut(CONFLICT);
      const error = await rejectionOf(pending);

      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS]);
      expect(error).toBeInstanceOf(SyncServerChangedError);
    });

    it("counts a PUT that already landed as saved, with no further request", async () => {
      const releasePut = holdOnce(PUT_BOOKS);

      const pending = upload(PUT_RAW);
      await inFlight(PUT_BOOKS);
      client.setEndpoint(OFFICIAL);
      releasePut(PUT_LANDED);
      const result = await pending;

      expect(result).toEqual({
        ok: true,
        landed: {
          usePut: true,
          books: LOCAL_BOOKS,
          sent: [
            { bookId: A, isShared: BoolFlag.TRUE },
            { bookId: D, isShared: BoolFlag.TRUE },
          ],
          raw: { lastUpdated: LANDED_STAMP },
        },
      });
      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS]);
    });

    it("pins at the call: a move right after it changes neither the first PUT nor the stop", async () => {
      const releasePut = holdOnce(PUT_BOOKS);

      const pending = upload(PUT_RAW);
      client.setEndpoint(OFFICIAL);
      // No await above: the first PUT had already left when the endpoint moved.
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS]);
      releasePut(CONFLICT);
      const error = await rejectionOf(pending);

      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS]);
      expect(error).toBeInstanceOf(SyncServerChangedError);
    });
  });

  describe("when the endpoint does not move", () => {
    it("re-reads and re-sends on the family server after a 409", async () => {
      replyOnce(PUT_BOOKS, CONFLICT);

      const result = await upload(PUT_RAW);

      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PUT_BOOKS, GET_BOOKS, PUT_BOOKS]);
      expect(received[0].body?.expectedLastUpdated).toBe(READ_STAMP);
      expect(received[2].body?.expectedLastUpdated).toBe(REREAD_STAMP);
      expect(result.ok).toBe(true);
    });
  });

  describe("the PATCH path, which is not pinned", () => {
    it("sends its one PATCH to the server held at the call, and a later move neither stops nor resends it", async () => {
      const releasePatch = holdOnce(PATCH_BOOKS);

      const pending = upload(PATCH_RAW);
      client.setEndpoint(OFFICIAL);
      expect(sentTo(FAMILY_SERVER)).toEqual([PATCH_BOOKS]);
      releasePatch(ok({ ok: true, applied: 1 }));
      const result = await pending;

      expect(result).toEqual({
        ok: true,
        landed: {
          usePut: false,
          books: LOCAL_BOOKS,
          sent: [{ bookId: D, isShared: BoolFlag.TRUE }],
          raw: PATCH_RAW,
        },
      });
      expect(received[0].body).toEqual({
        changes: [{ bookId: D, isShared: BoolFlag.TRUE }],
      });
      expect(sentTo(OFFICIAL)).toEqual([]);
      expect(sentTo(FAMILY_SERVER)).toEqual([PATCH_BOOKS]);
    });
  });
});
