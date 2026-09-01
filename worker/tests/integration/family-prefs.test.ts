import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  BoolFlag,
  kvKeys,
  MAX_FAMILY_PREF_ENTRIES,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { generateAuthToken } from "../../src/middleware/auth";
import { USER1, USER2 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

// Canonical 64-char lowercase SHA-256 hex ownerId for building valid hidden refs.
const OWNER = "a".repeat(64);
const ref = (bookId: string) => `${OWNER}:${bookId}`;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  // DEV_MODE: "1" bypasses the per-user rate limit (matches existing helpers).
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function rawRequest(
  method: string,
  path: string,
  rawBody: string,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv, DEV_MODE: "1" },
  );
}

async function createFamilyAndGetToken(userId = USER1) {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

/** Seed a user:{userId} record directly so family-prefs has a record to update. */
async function seedUser(
  userId: string,
  overrides: Partial<UserBooksRecord> = {},
): Promise<void> {
  const record: UserBooksRecord = {
    schemaVersion: 1,
    userId,
    displayName: "Seeded Name",
    books: [
      {
        bookId: "b1",
        title: "Book 1",
        author: "",
        isbn: "",
        coverUrl: "",
        readmooUrl: "",
        category: "",
        isShared: 0,
      },
    ],
    lastUpdated: "2020-01-01T00:00:00.000Z",
    ...overrides,
  } as UserBooksRecord;
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

beforeEach(() => {
  kv = createMockKV();
});

// `watchKvOps` installs `vi.spyOn` handlers and does not clean up after itself.
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — auth & validation
// ===========================================================================

describe("PUT /api/user/:id/family-prefs — auth & validation", () => {
  it("returns 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("PUT", `/api/user/${USER1}/family-prefs`, {
      hidden: [],
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 FORBIDDEN when authenticated as a different user", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER2}/family-prefs`,
      { hidden: [] },
      authToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 INVALID_USER_ID for a malformed userId", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "PUT",
      "/api/user/user<script>/family-prefs",
      { hidden: [] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("returns 400 INVALID_JSON for a non-JSON body", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await rawRequest(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      "{not valid}",
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("returns 400 (not 500) for a valid-JSON primitive body (PR #60 WARNING 1)", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    // `5` is valid JSON but not an object; the parse guard must reject it as a
    // clean 400 rather than letting `kind in body` throw → 500.
    const res = await rawRequest(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      "5",
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it.each<{ label: string; body: unknown }>([
    { label: "hidden missing", body: {} },
    { label: "hidden is not an array", body: { hidden: "not-array" } },
    { label: "an entry is invalid", body: { hidden: ["not-a-valid-ref"] } },
    { label: "an entry is a non-string", body: { hidden: [123] } },
  ])("returns 400 INVALID_PAYLOAD when $label", async ({ body }) => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      body,
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects an over-max hidden payload with 400 INVALID_PAYLOAD (handler over-limit branch)", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    // MAX_FAMILY_PREF_ENTRIES (3000) is sized so that an over-limit unique set
    // (MAX + 1 refs, ~77 bytes each ≈ 231KB) still fits under the 256KB global
    // body-size guard. The request therefore reaches the handler and trips its
    // own over-max → 400 INVALID_PAYLOAD branch (rather than being pre-empted
    // by the 413 body guard), keeping that branch reachable over real HTTP.
    const hidden = Array.from({ length: MAX_FAMILY_PREF_ENTRIES + 1 }, (_, i) =>
      ref(`book-${i}`),
    );
    // Guard the test itself: the payload must stay within the body limit, else
    // we'd be exercising the 413 path instead of the 400 branch under test.
    expect(JSON.stringify({ hidden }).length).toBeLessThan(262144);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 404 NOT_FOUND when the user record does not exist", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    // Do NOT seed user:user1 — record is absent.

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b1")] },
      authToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — behavior (write / read-back / overwrite)
// ===========================================================================

describe("PUT /api/user/:id/family-prefs — behavior", () => {
  it("writes familyShelfPrefs and GET /books reads back the deduped set", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    // Includes a duplicate that must be removed (first-seen order preserved).
    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b1"), ref("b2"), ref("b1")] },
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);
    expect(json.data.hidden).toEqual([ref("b1"), ref("b2")]);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([
      ref("b1"),
      ref("b2"),
    ]);
  });

  it("an empty array clears a previously-set hidden list", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    // Set some hidden refs first.
    await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b1"), ref("b2")] },
      authToken,
    );

    // Then clear with an empty array.
    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [] },
      authToken,
    );
    expect(res.status).toBe(200);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([]);
  });

  it("two consecutive PUTs → final value equals the SECOND request's set (full overwrite)", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b1"), ref("b2")] },
      authToken,
    );
    await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b3")] },
      authToken,
    );

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    // Full-overwrite: b1/b2 are gone, only the second set remains.
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([ref("b3")]);
  });

  it("preserves books, displayName, and lastUpdated (byte-identical) untouched", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    const KNOWN_LAST_UPDATED = "2021-06-15T08:30:00.000Z";
    // Both covers must be on the Readmoo cover-host whitelist: this handler
    // scrubs every carried-over coverUrl (see the lazy-cleanup suite below), so
    // an arbitrary host here would test blanking, not byte-identical carry-over.
    const seededBooks = [
      {
        bookId: "b1",
        title: "Preserved Book",
        author: "Jane",
        isbn: "978-x",
        coverUrl: "https://cdn.readmoo.com/b1.jpg",
        readmooUrl: "https://readmoo.com/book/b1",
        category: "sci-fi",
        isShared: 1,
      },
      {
        bookId: "b2",
        title: "Second Book",
        author: "Joe",
        isbn: "978-y",
        coverUrl: "https://cdn.readmoo.com/b2.jpg",
        readmooUrl: "https://readmoo.com/book/b2",
        category: "fiction",
        isShared: 0,
      },
    ];
    await seedUser(USER1, {
      displayName: "Keep This Name",
      books: seededBooks,
      lastUpdated: KNOWN_LAST_UPDATED,
    });

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("b1")] },
      authToken,
    );
    expect(res.status).toBe(200);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    // Other fields unchanged.
    expect(getJson.data.displayName).toBe("Keep This Name");
    expect(getJson.data.books).toEqual(seededBooks);
    expect(getJson.data.lastUpdated).toBe(KNOWN_LAST_UPDATED);
    // familyShelfPrefs updated.
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([ref("b1")]);
  });
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — favorites & merge semantics (Wave F)
// ===========================================================================

describe("PUT /api/user/:id/family-prefs — favorites & merge semantics", () => {
  it("response shape is { data: { ok, hidden, favorites } } with both lists", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("h1")], favorites: [ref("f1")] },
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.ok).toBe(true);
    expect(json.data.hidden).toEqual([ref("h1")]);
    expect(json.data.favorites).toEqual([ref("f1")]);
  });

  it("favorites-only PUT preserves existing hidden and replaces favorites", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1, {
      familyShelfPrefs: { hidden: [ref("h1"), ref("h2")], favorites: [] },
    });

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { favorites: [ref("f1"), ref("f2")] },
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    // Response reflects the merged container: hidden preserved, favorites replaced.
    expect(json.data.hidden).toEqual([ref("h1"), ref("h2")]);
    expect(json.data.favorites).toEqual([ref("f1"), ref("f2")]);

    // KV read-back confirms the same merge landed on disk.
    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([
      ref("h1"),
      ref("h2"),
    ]);
    expect(getJson.data.familyShelfPrefs.favorites).toEqual([
      ref("f1"),
      ref("f2"),
    ]);
  });

  it("hidden-only PUT (old v1.5.0 client) preserves existing favorites — regression guard", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1, {
      familyShelfPrefs: { hidden: [], favorites: [ref("f1"), ref("f2")] },
    });

    // An old client that only knows about `hidden` must NOT wipe favorites.
    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("h1")] },
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.hidden).toEqual([ref("h1")]);
    expect(json.data.favorites).toEqual([ref("f1"), ref("f2")]);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([ref("h1")]);
    expect(getJson.data.familyShelfPrefs.favorites).toEqual([
      ref("f1"),
      ref("f2"),
    ]);
  });

  it("PUT with both fields replaces both lists", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1, {
      familyShelfPrefs: { hidden: [ref("old-h")], favorites: [ref("old-f")] },
    });

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { hidden: [ref("h1")], favorites: [ref("f1")] },
      authToken,
    );
    expect(res.status).toBe(200);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs.hidden).toEqual([ref("h1")]);
    expect(getJson.data.familyShelfPrefs.favorites).toEqual([ref("f1")]);
  });

  it("defaults an absent field to [] when neither the body nor existing record has it", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    // Seeded record has no familyShelfPrefs at all.
    await seedUser(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { favorites: [ref("f1")] },
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    // favorites set from body; hidden defaults to [] (no prior value).
    expect(json.data.favorites).toEqual([ref("f1")]);
    expect(json.data.hidden).toEqual([]);

    const getRes = await request(
      "GET",
      `/api/user/${USER1}/books`,
      undefined,
      authToken,
    );
    const getJson = (await getRes.json()) as Json;
    expect(getJson.data.familyShelfPrefs).toEqual({
      hidden: [],
      favorites: [ref("f1")],
    });
  });

  it("returns 400 INVALID_PAYLOAD when neither hidden nor favorites is present", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { unrelated: true },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 400 INVALID_PAYLOAD for an invalid favorites entry", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1);

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { favorites: ["not-a-valid-ref"] },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns 404 NOT_FOUND for a favorites PUT when no record exists", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);
    // No seedUser → record absent.

    const res = await request(
      "PUT",
      `/api/user/${USER1}/family-prefs`,
      { favorites: [ref("f1")] },
      authToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — coverUrl lazy cleanup (P0 privacy)
//
// A book cover is fetched by every family member and every public-shelf
// visitor, so an attacker-chosen cover host acts as a tracking beacon. The
// books write paths block new ones at the boundary; this handler additionally
// SCRUBS records written before that guard existed. The cleanup is
// opportunistic on purpose: it rides the record write this handler performs
// anyway and never forces one — in particular it publishes no snapshot, so a
// stale snapshot stays poisoned until the owner's next books write.
// ===========================================================================

describe("PUT /api/user/:id/family-prefs — coverUrl lazy cleanup", () => {
  const POISONED_COVER = "https://evil.example.com/beacon.gif";
  const POISONED_HOST = "evil.example.com";
  /** On the Readmoo cover-host whitelist (`isAllowedCoverUrl`), so it survives. */
  const CLEAN_COVER = "https://cdn.readmoo.com/clean.jpg";

  const SHELF_ID = "11111111-1111-4111-8111-111111111111";
  const SHARE_TOKEN = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
  const SHELF_CREATED_AT = Date.parse("2026-02-01T00:00:00.000Z");

  function book(bookId: string, coverUrl: string): BookEntry {
    return {
      bookId,
      title: `Book ${bookId}`,
      author: "Author",
      isbn: `isbn-${bookId}`,
      coverUrl,
      readmooUrl: `https://readmoo.com/book/${bookId}`,
      category: "fiction",
      isShared: BoolFlag.TRUE,
    };
  }

  /** Poisoned covers in the FIRST and LAST slots — position must not matter. */
  function legacyBooks(): BookEntry[] {
    return [
      book("b1", POISONED_COVER),
      book("b2", CLEAN_COVER),
      book("b3", POISONED_COVER),
    ];
  }

  /**
   * Seed `user:{USER1}` DIRECTLY (the file's `seedUser` writes to KV without
   * going through a handler). A poisoned coverUrl can only be in KV because it
   * was written BEFORE the whitelist existed — the books write paths sanitize
   * on the way in, so they cannot produce this fixture.
   */
  async function seedLegacyRecord(): Promise<string> {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1, { books: legacyBooks() });
    return authToken;
  }

  function storedRecord(): Promise<UserBooksRecord | null> {
    return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
  }

  function savePrefs(
    authToken: string,
    body: unknown = { hidden: [ref("b1")] },
  ) {
    return request("PUT", `/api/user/${USER1}/family-prefs`, body, authToken);
  }

  it("scrubs a pre-whitelist poisoned coverUrl when saving family-prefs", async () => {
    const authToken = await seedLegacyRecord();

    const res = await savePrefs(authToken);
    expect(res.status).toBe(200);

    const record = await storedRecord();
    expect(record?.books.map((b) => b.coverUrl)).toEqual(["", CLEAN_COVER, ""]);
    // The whitelisted control survives field for field, not just its cover.
    expect(record?.books[1]).toEqual(book("b2", CLEAN_COVER));
  });

  it("keeps every other field of a scrubbed book unchanged", async () => {
    const authToken = await seedLegacyRecord();

    await savePrefs(authToken);

    const record = await storedRecord();
    // Only the cover moved: title, isShared and the rest are byte-identical.
    expect(record?.books[0]).toEqual({
      ...book("b1", POISONED_COVER),
      coverUrl: "",
    });
    // Nothing anywhere in the record — not in a stray field, not in a title.
    expect(JSON.stringify(record)).not.toContain(POISONED_HOST);
  });

  it("still applies the requested prefs while cleaning up", async () => {
    const authToken = await seedLegacyRecord();

    const res = await savePrefs(authToken, {
      hidden: [ref("b1")],
      favorites: [ref("b2")],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.hidden).toEqual([ref("b1")]);
    expect(json.data.favorites).toEqual([ref("b2")]);

    const record = await storedRecord();
    expect(record?.familyShelfPrefs).toEqual({
      hidden: [ref("b1")],
      favorites: [ref("b2")],
    });
  });

  it("writes only the user record — the cleanup publishes no snapshot", async () => {
    const authToken = await seedLegacyRecord();
    // A migrated owner with one live shelf whose snapshot was published BEFORE
    // the whitelist existed. Seeded raw rather than through the production
    // writer (`writePublicSnapshot`), which sanitizes covers and so cannot mint
    // a poisoned snapshot.
    const pointer: PublicShelvesRecord = {
      shelves: [
        {
          shelfId: SHELF_ID,
          shareToken: SHARE_TOKEN,
          title: "公開書櫃",
          expiresDays: null,
          createdAt: SHELF_CREATED_AT,
          expiresAt: null,
          selectionMode: "all-shared",
        } satisfies PublicShelf,
      ],
    };
    const staleSnapshot = JSON.stringify({
      userId: USER1,
      shelfId: SHELF_ID,
      title: "公開書櫃",
      books: [book("b1", POISONED_COVER)],
      createdAt: SHELF_CREATED_AT,
      expiresAt: null,
    } satisfies PublicShelfSnapshot);
    await kv.put(kvKeys.publicShelves(USER1), JSON.stringify(pointer));
    await kv.put(kvKeys.publicShelf(SHARE_TOKEN), staleSnapshot);

    const ops = watchKvOps(kv);
    const res = await savePrefs(authToken);
    expect(res.status).toBe(200);

    // The record write is the handler's ONLY mutation: the cleanup rides a write
    // that was going to happen anyway and must never become a snapshot write of
    // its own. (DEV_MODE elides the rate-limit counter put, so this trail is the
    // handler's own writes — see the scope caveat in `helpers/kvOps.ts`.)
    expect(ops.writeTrail()).toEqual([`put ${kvKeys.user(USER1)}`]);
    // No pointer read either — this path publishes nothing, so it needs no
    // shelf list (`.claude/rules/backend.md`, single-writer public-shelf domain).
    expect(ops.getKeys()).not.toContain(kvKeys.publicShelves(USER1));
    // Documented convergence gap: the record is now cleaner than the snapshot,
    // which stays poisoned until the owner's next books write rebuilds it.
    expect(await kv.get(kvKeys.publicShelf(SHARE_TOKEN))).toBe(staleSnapshot);
  });

  it("leaves the poisoned cover untouched when the request is rejected", async () => {
    const authToken = await seedLegacyRecord();
    const ops = watchKvOps(kv);

    const res = await savePrefs(authToken, { hidden: ["not-a-valid-ref"] });
    expect(res.status).toBe(400);

    // Validation runs before the record read/rebuild, so a refused request
    // performs no handler write at all — the cleanup rides an accepted save
    // only. (Rate-limit counter puts are elided by DEV_MODE.)
    expect(ops.putKeys()).toEqual([]);
    const record = await storedRecord();
    expect(record?.books[0].coverUrl).toBe(POISONED_COVER);
  });
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — readmooUrl lazy cleanup (P0 privacy)
//
// Twin of the coverUrl cleanup above for the other attacker-controlled URL
// field. `readmooUrl` is rendered as a clickable `<a href>`, so a value written
// before the whitelist existed is a phishing / arbitrary-redirect lure sitting
// under a legitimate book title. This handler rebuilds the books array anyway,
// so it scrubs while it is there — and, exactly as with covers, it must touch
// nothing else on the record.
// ===========================================================================

describe("PUT /api/user/:id/family-prefs — readmooUrl lazy cleanup", () => {
  const PHISHING_HOST = "phish.example.com";
  const POISONED_LINK = `https://${PHISHING_HOST}/login`;
  /** On the Readmoo whitelist (`isAllowedBookUrl`), so it must survive. */
  const CLEAN_LINK = "https://readmoo.com/book/210123456";
  const SEEDED_AT = "2020-01-01T00:00:00.000Z";
  const SEEDED_NAME = "Seeded Name";

  function book(bookId: string, readmooUrl: string): BookEntry {
    return {
      bookId,
      title: `Book ${bookId}`,
      author: "Author",
      isbn: `isbn-${bookId}`,
      coverUrl: "https://cdn.readmoo.com/clean.jpg",
      readmooUrl,
      category: "fiction",
      isShared: BoolFlag.TRUE,
    };
  }

  /** Poisoned links in the FIRST and LAST slots — position must not matter. */
  function legacyBooks(): BookEntry[] {
    return [
      book("b1", POISONED_LINK),
      book("b2", CLEAN_LINK),
      book("b3", POISONED_LINK),
    ];
  }

  /**
   * Seed `user:{USER1}` DIRECTLY. A poisoned readmooUrl can only be in KV
   * because it was written BEFORE the whitelist existed — the books write paths
   * sanitize on the way in, so they cannot produce this fixture.
   */
  async function seedLegacyRecord(): Promise<string> {
    const { authToken } = await createFamilyAndGetToken(USER1);
    await seedUser(USER1, {
      books: legacyBooks(),
      displayName: SEEDED_NAME,
      lastUpdated: SEEDED_AT,
    });
    return authToken;
  }

  function storedRecord(): Promise<UserBooksRecord | null> {
    return kv.get<UserBooksRecord>(kvKeys.user(USER1), "json");
  }

  function savePrefs(
    authToken: string,
    body: unknown = { hidden: [ref("b1")] },
  ) {
    return request("PUT", `/api/user/${USER1}/family-prefs`, body, authToken);
  }

  it("scrubs a pre-whitelist poisoned readmooUrl when saving family-prefs", async () => {
    const authToken = await seedLegacyRecord();

    const res = await savePrefs(authToken);
    expect(res.status).toBe(200);

    const record = await storedRecord();
    expect(record?.books.map((b) => b.readmooUrl)).toEqual([
      "",
      CLEAN_LINK,
      "",
    ]);
    // The whitelisted control survives field for field, not just its link.
    expect(record?.books[1]).toEqual(book("b2", CLEAN_LINK));
  });

  it("keeps every other field of a scrubbed book unchanged", async () => {
    const authToken = await seedLegacyRecord();

    await savePrefs(authToken);

    const record = await storedRecord();
    // Only the link moved: title, cover, isShared and the rest are
    // byte-identical — the two URL fields are sanitized independently.
    expect(record?.books[0]).toEqual({
      ...book("b1", POISONED_LINK),
      readmooUrl: "",
    });
    // Nothing anywhere in the record — not in a stray field, not in a title.
    expect(JSON.stringify(record)).not.toContain(PHISHING_HOST);
  });

  it("leaves the non-book record fields untouched while scrubbing", async () => {
    const authToken = await seedLegacyRecord();

    const res = await savePrefs(authToken);
    expect(res.status).toBe(200);

    const record = await storedRecord();
    // Per-field merge semantics: the scrub rides the write, it does not widen
    // it. displayName / schemaVersion / lastUpdated are carried over verbatim.
    expect(record?.displayName).toBe(SEEDED_NAME);
    expect(record?.schemaVersion).toBe(1);
    expect(record?.lastUpdated).toBe(SEEDED_AT);
    // The prefs themselves ARE the point of the request, and the merge always
    // normalizes both kinds — an absent `favorites` lands as [], not undefined.
    expect(record?.familyShelfPrefs).toEqual({
      hidden: [ref("b1")],
      favorites: [],
    });
  });

  it("leaves the poisoned link untouched when the request is rejected", async () => {
    const authToken = await seedLegacyRecord();
    const ops = watchKvOps(kv);

    const res = await savePrefs(authToken, { hidden: ["not-a-valid-ref"] });
    expect(res.status).toBe(400);

    // Validation runs before the record read/rebuild, so a refused request
    // performs no handler write at all — the cleanup rides an accepted save
    // only. (Rate-limit counter puts are elided by DEV_MODE.)
    expect(ops.putKeys()).toEqual([]);
    const record = await storedRecord();
    expect(record?.books[0].readmooUrl).toBe(POISONED_LINK);
  });
});

// ===========================================================================
// PUT /api/user/:id/family-prefs — per-user rate limit (non-dev mode)
// ===========================================================================

describe("PUT /:id/family-prefs per-user rate limit", () => {
  const TEST_USER = "f".repeat(64);

  function prodRequest(
    method: string,
    path: string,
    body?: unknown,
    authToken?: string,
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    // No DEV_MODE → per-user rate limit is enforced.
    return app.request(path, init, { KV: kv });
  }

  it("returns 429 after 60 family-prefs PUTs per user per hour", async () => {
    const token = await generateAuthToken(kv, TEST_USER);
    await seedUser(TEST_USER);
    const body = { hidden: [ref("b1")] };

    for (let i = 0; i < 60; i++) {
      const res = await prodRequest(
        "PUT",
        `/api/user/${TEST_USER}/family-prefs`,
        body,
        token,
      );
      expect(res.status).toBe(200);
    }

    const blocked = await prodRequest(
      "PUT",
      `/api/user/${TEST_USER}/family-prefs`,
      body,
      token,
    );
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});
