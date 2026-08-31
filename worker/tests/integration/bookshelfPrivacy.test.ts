import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  BoolFlag,
  kvKeys,
  type UserBooksRecord,
  type BookEntry,
} from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";
import { USER1, USER2 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Non-dev request (rate limits active). */
function prodRequest(method: string, path: string, authToken?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  return app.request(path, { method, headers }, { KV: kv });
}

function book(
  bookId: string,
  isShared: BoolFlag,
  coverUrl = "",
  readmooUrl = "",
): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "",
    isbn: "",
    coverUrl,
    readmooUrl,
    category: "",
    isShared,
  };
}

/**
 * A book as it can sit in KV. The coverless variant models a record written
 * before `coverUrl` was always populated; it is unreachable through a write
 * handler (`parseBooks` always emits the field), so it can only be seeded raw.
 */
type SeededBook = BookEntry | Omit<BookEntry, "coverUrl">;

interface MemberSeed {
  userId: string;
  displayName: string;
  books: SeededBook[];
}

/**
 * Seed a family plus one `user:{id}` books record per member, written DIRECTLY
 * to KV. `members[0]` is the owner and the caller whose auth token is returned.
 */
async function seedFamily(
  members: MemberSeed[],
): Promise<{ familyId: string; token: string }> {
  const familyId = "abcd-1234";
  const owner = members[0];
  const token = await generateAuthToken(kv, owner.userId);
  await kv.put(
    kvKeys.family(familyId),
    JSON.stringify({
      familyId,
      ownerId: owner.userId,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        canLend: BoolFlag.TRUE,
      })),
      maxMembers: Math.max(2, members.length),
      createdAt: new Date().toISOString(),
    }),
  );
  for (const m of members) {
    await kv.put(kvKeys.member(m.userId), familyId);
    // Anchored to the production record type except for `books`, which is
    // widened so a coverless legacy entry can be seeded.
    const record: Omit<UserBooksRecord, "books"> & { books: SeededBook[] } = {
      schemaVersion: 1,
      userId: m.userId,
      displayName: m.displayName,
      books: m.books,
      lastUpdated: new Date().toISOString(),
    };
    await kv.put(kvKeys.user(m.userId), JSON.stringify(record));
  }
  return { familyId, token };
}

/** Seed a family with USER1 as sole owner + a user record with the given books. */
async function seedSoloFamily(
  books: BookEntry[],
): Promise<{ familyId: string; token: string }> {
  return seedFamily([{ userId: USER1, displayName: "Owner", books }]);
}

beforeEach(() => {
  kv = createMockKV();
});

// `watchKvOps` installs `vi.spyOn` handlers and does not clean up after itself.
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// TEST-1: privacy filter — unshared books MUST be excluded from aggregation.
// This fails if someone deletes the `.filter(... === BoolFlag.TRUE)` line.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — privacy filter", () => {
  it("returns ONLY shared books and omits every unshared book from a mixed shelf", async () => {
    const { familyId, token } = await seedSoloFamily([
      book("shared-1", BoolFlag.TRUE),
      book("private-1", BoolFlag.FALSE),
      book("shared-2", BoolFlag.TRUE),
      book("private-2", BoolFlag.FALSE),
    ]);

    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;

    const returnedIds: string[] = json.data.members[0].books.map(
      (b: BookEntry) => b.bookId,
    );

    // Shared books present …
    expect(returnedIds).toContain("shared-1");
    expect(returnedIds).toContain("shared-2");
    // … unshared books absent.
    expect(returnedIds).not.toContain("private-1");
    expect(returnedIds).not.toContain("private-2");
    // Exactly the two shared ones, nothing else leaked.
    expect(returnedIds).toHaveLength(2);
  });

  it("returns an empty book list when the member has no shared books", async () => {
    const { familyId, token } = await seedSoloFamily([
      book("private-1", BoolFlag.FALSE),
      book("private-2", BoolFlag.FALSE),
    ]);

    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token,
    );
    const json = (await res.json()) as Json;
    expect(json.data.members[0].books).toEqual([]);
  });
});

// ===========================================================================
// Read-side coverUrl sanitize (P0 privacy): the aggregation is the read-side
// twin of the `buildSnapshot` chokepoint. A `user:{id}` record poisoned BEFORE
// the whitelist existed, whose owner never syncs again, would otherwise beacon
// every family member on every shelf open — the dialog renders these covers
// under Readmoo's page CSP, so there is no client-side lever. The write paths
// cannot fix such a record (they only sanitize what they are asked to write),
// so the scrub happens on the way out. Read-side ONLY: no repair write.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — coverUrl read-side sanitize", () => {
  /** An attacker-chosen cover host — a tracking beacon once rendered. */
  const BEACON_COVER = "https://evil.example.com/beacon.gif";
  const BEACON_HOST = "evil.example.com";
  /** On the Readmoo cover-host whitelist (`isAllowedCoverUrl`), so it survives. */
  const CLEAN_COVER = "https://cdn.readmoo.com/clean.jpg";

  /**
   * A shared book stored with NO `coverUrl` key at all — the other legacy shape
   * the aggregation has to survive. Typed as an `Omit` of the production entry
   * so it still breaks if `BookEntry` gains a required field.
   */
  const COVERLESS_BOOK: Omit<BookEntry, "coverUrl"> = {
    bookId: "coverless",
    title: "Title coverless",
    author: "",
    isbn: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };

  /** Member A (the caller) holds the poison + a control; member B is clean. */
  function seedPoisonedFamily(): Promise<{ familyId: string; token: string }> {
    return seedFamily([
      {
        userId: USER1,
        displayName: "Owner",
        books: [
          book("a-poisoned", BoolFlag.TRUE, BEACON_COVER),
          book("a-clean", BoolFlag.TRUE, CLEAN_COVER),
        ],
      },
      {
        userId: USER2,
        displayName: "Member",
        books: [book("b-clean", BoolFlag.TRUE, CLEAN_COVER)],
      },
    ]);
  }

  /** GET the shelf, returning the RAW body too — host leaks hide in any field. */
  async function fetchShelf(
    familyId: string,
    token: string,
  ): Promise<{ body: string; json: Json }> {
    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    return { body, json: JSON.parse(body) as Json };
  }

  function booksOf(json: Json, userId: string): BookEntry[] {
    const member = json.data.members.find((m: Json) => m.userId === userId);
    expect(member).toBeDefined();
    return member.books as BookEntry[];
  }

  it("blanks an off-whitelist cover while returning every whitelisted cover byte-identical", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { json } = await fetchShelf(familyId, token);

    // The poisoned entry is blanked; the control beside it and the second
    // member's cover are untouched — the scrub is per-book, not per-member.
    expect(booksOf(json, USER1).map((b) => b.coverUrl)).toEqual([
      "",
      CLEAN_COVER,
    ]);
    expect(booksOf(json, USER2).map((b) => b.coverUrl)).toEqual([CLEAN_COVER]);
  });

  it("keeps the poisoned book itself, with every field but its cover intact", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { json } = await fetchShelf(familyId, token);

    // Sanitize, never drop: the member still sees the book (title, id, and the
    // rest byte-identical), it just renders as the normal no-cover state.
    const poisoned = booksOf(json, USER1).find(
      (b) => b.bookId === "a-poisoned",
    );
    expect(poisoned).toEqual({
      ...book("a-poisoned", BoolFlag.TRUE, BEACON_COVER),
      coverUrl: "",
    });
  });

  it("leaks the beacon host nowhere in the response body", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { body } = await fetchShelf(familyId, token);

    // Not in a cover, not in a title, not in a stray carried-over field.
    expect(body).not.toContain(BEACON_HOST);
  });

  it("performs no KV write and leaves the poisoned record exactly as stored", async () => {
    const { familyId, token } = await seedPoisonedFamily();
    const ops = watchKvOps(kv);

    await fetchShelf(familyId, token);

    // The scrub is a response transform, not a lazy repair: an aggregation read
    // must never mutate another member's record. (DEV_MODE elides the
    // rate-limit counter put, so this trail is the handler's own writes — see
    // the scope caveat in `helpers/kvOps.ts`.)
    expect(ops.writeTrail()).toEqual([]);
    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.books.map((b) => b.coverUrl)).toEqual([
      BEACON_COVER,
      CLEAN_COVER,
    ]);
  });

  it("returns an empty-string coverUrl for a book stored without the field", async () => {
    const { familyId, token } = await seedFamily([
      { userId: USER1, displayName: "Owner", books: [COVERLESS_BOOK] },
    ]);

    const { json } = await fetchShelf(familyId, token);

    // Deliberate side effect of the unconditional assignment in the spread: the
    // field is always PRESENT in the response, even when the record lacks it.
    const returned = booksOf(json, USER1)[0];
    expect(returned).toEqual({ ...COVERLESS_BOOK, coverUrl: "" });
    expect("coverUrl" in returned).toBe(true);
  });

  it("does not add the missing coverUrl field back to the stored record", async () => {
    const { familyId, token } = await seedFamily([
      { userId: USER1, displayName: "Owner", books: [COVERLESS_BOOK] },
    ]);

    await fetchShelf(familyId, token);

    // The normalization lives in the response only — KV keeps the legacy shape.
    const raw = await kv.get(kvKeys.user(USER1));
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("coverUrl");
  });

  it("excludes a poisoned NON-shared book, leaking neither its id nor its host", async () => {
    const { familyId, token } = await seedFamily([
      {
        userId: USER1,
        displayName: "Owner",
        books: [
          book("private-poisoned", BoolFlag.FALSE, BEACON_COVER),
          book("shared-clean", BoolFlag.TRUE, CLEAN_COVER),
        ],
      },
    ]);

    const { body, json } = await fetchShelf(familyId, token);

    // Filter runs before the map: an unshared book is never sanitized-then-
    // returned, it is simply absent. The privacy filter still outranks the scrub.
    expect(booksOf(json, USER1).map((b) => b.bookId)).toEqual(["shared-clean"]);
    expect(body).not.toContain("private-poisoned");
    expect(body).not.toContain(BEACON_HOST);
  });
});

// ===========================================================================
// Read-side readmooUrl sanitize (P0 privacy): the same read-side twin argument
// as the covers above, applied to the OTHER attacker-controlled URL field. A
// `user:{id}` record poisoned BEFORE the whitelist existed, whose owner never
// syncs again, would otherwise hand every family member a clickable phishing /
// arbitrary-redirect link under a legitimate book title. This is the case that
// matters most for a DORMANT account: no write path can ever reach such a
// record, and a CSP cannot help — `img-src` never constrained a navigation. So
// the scrub happens on the way out, response-only, with no repair write.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — readmooUrl read-side sanitize", () => {
  /** An attacker-chosen destination — a phishing lure once clicked. */
  const PHISHING_HOST = "phish.example.com";
  const PHISHING_LINK = `https://${PHISHING_HOST}/login`;
  /** On the Readmoo whitelist (`isAllowedBookUrl`), so it survives. */
  const CLEAN_LINK = "https://readmoo.com/book/210123456";
  /** Whitelisted cover, so a blanked link cannot be confused with a blanked cover. */
  const CLEAN_COVER = "https://cdn.readmoo.com/clean.jpg";

  /** Member A (the caller) holds the poison + a control; member B is clean. */
  function seedPoisonedFamily(): Promise<{ familyId: string; token: string }> {
    return seedFamily([
      {
        userId: USER1,
        displayName: "Owner",
        books: [
          book("a-poisoned", BoolFlag.TRUE, CLEAN_COVER, PHISHING_LINK),
          book("a-clean", BoolFlag.TRUE, CLEAN_COVER, CLEAN_LINK),
        ],
      },
      {
        userId: USER2,
        displayName: "Member",
        books: [book("b-clean", BoolFlag.TRUE, CLEAN_COVER, CLEAN_LINK)],
      },
    ]);
  }

  /** GET the shelf, returning the RAW body too — host leaks hide in any field. */
  async function fetchShelf(
    familyId: string,
    token: string,
  ): Promise<{ body: string; json: Json }> {
    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      token,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    return { body, json: JSON.parse(body) as Json };
  }

  function booksOf(json: Json, userId: string): BookEntry[] {
    const member = json.data.members.find((m: Json) => m.userId === userId);
    expect(member).toBeDefined();
    return member.books as BookEntry[];
  }

  it("blanks an off-whitelist book link while returning every whitelisted one byte-identical", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { json } = await fetchShelf(familyId, token);

    // The poisoned entry is blanked; the control beside it and the second
    // member's link are untouched — the scrub is per-book, not per-member.
    expect(booksOf(json, USER1).map((b) => b.readmooUrl)).toEqual([
      "",
      CLEAN_LINK,
    ]);
    expect(booksOf(json, USER2).map((b) => b.readmooUrl)).toEqual([CLEAN_LINK]);
  });

  it("keeps the poisoned book itself, with every field but its link intact", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { json } = await fetchShelf(familyId, token);

    // Sanitize, never drop: the member still sees the book, and its whitelisted
    // cover survives — the two URL fields are scrubbed independently.
    const poisoned = booksOf(json, USER1).find(
      (b) => b.bookId === "a-poisoned",
    );
    expect(poisoned).toEqual({
      ...book("a-poisoned", BoolFlag.TRUE, CLEAN_COVER, PHISHING_LINK),
      readmooUrl: "",
    });
  });

  it("leaks the phishing host nowhere in the response body", async () => {
    const { familyId, token } = await seedPoisonedFamily();

    const { body } = await fetchShelf(familyId, token);

    // Not in a link, not in a title, not in a stray carried-over field.
    expect(body).not.toContain(PHISHING_HOST);
  });

  it("performs no KV write and leaves the poisoned record exactly as stored", async () => {
    const { familyId, token } = await seedPoisonedFamily();
    const ops = watchKvOps(kv);

    await fetchShelf(familyId, token);

    // Anti-tautology anchor: the response is clean because THIS handler
    // scrubbed it, not because something repaired KV first. An aggregation read
    // must never mutate another member's record. (DEV_MODE elides the
    // rate-limit counter put — see the scope caveat in `helpers/kvOps.ts`.)
    expect(ops.writeTrail()).toEqual([]);
    const stored = await kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
    expect(stored?.books.map((b) => b.readmooUrl)).toEqual([
      PHISHING_LINK,
      CLEAN_LINK,
    ]);
  });

  it("excludes a poisoned NON-shared book, leaking neither its id nor its host", async () => {
    const { familyId, token } = await seedFamily([
      {
        userId: USER1,
        displayName: "Owner",
        books: [
          book("private-poisoned", BoolFlag.FALSE, CLEAN_COVER, PHISHING_LINK),
          book("shared-clean", BoolFlag.TRUE, CLEAN_COVER, CLEAN_LINK),
        ],
      },
    ]);

    const { body, json } = await fetchShelf(familyId, token);

    // Filter runs before the map: an unshared book is never sanitized-then-
    // returned, it is simply absent. The privacy filter still outranks the scrub.
    expect(booksOf(json, USER1).map((b) => b.bookId)).toEqual(["shared-clean"]);
    expect(body).not.toContain("private-poisoned");
    expect(body).not.toContain(PHISHING_HOST);
  });
});

// ===========================================================================
// BE-3: per-user rate limit on the bookshelf endpoint (max 30 / 60s window).
// Mirrors the borrow-list per-user rate-limit guard.
// ===========================================================================

describe("GET /api/family/:id/bookshelf — per-user rate limit", () => {
  it("rate-limits a single authenticated user after 30 requests within the window", async () => {
    const { familyId, token } = await seedSoloFamily([
      book("shared-1", BoolFlag.TRUE),
    ]);

    // 30 requests all succeed.
    for (let i = 0; i < 30; i++) {
      const res = await prodRequest(
        "GET",
        `/api/family/${familyId}/bookshelf`,
        token,
      );
      expect(res.status).toBe(200);
    }

    // 31st request is rate-limited.
    const blocked = await prodRequest(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      token,
    );
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
