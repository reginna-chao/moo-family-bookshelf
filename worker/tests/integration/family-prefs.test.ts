import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import {
  kvKeys,
  MAX_FAMILY_PREF_ENTRIES,
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
    const seededBooks = [
      {
        bookId: "b1",
        title: "Preserved Book",
        author: "Jane",
        isbn: "978-x",
        coverUrl: "https://img/b1.jpg",
        readmooUrl: "https://readmoo.com/book/b1",
        category: "sci-fi",
        isShared: 1,
      },
      {
        bookId: "b2",
        title: "Second Book",
        author: "Joe",
        isbn: "978-y",
        coverUrl: "https://img/b2.jpg",
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
