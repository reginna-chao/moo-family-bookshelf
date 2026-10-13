import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { seedAuthToken } from "../helpers/auth";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import {
  BoolFlag,
  kvKeys,
  type PublicShelf,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

/**
 * PUT /api/user/:id/new-book-default (#238) — the per-user "newly synced books
 * default to shared" setting. It lives in its OWN key,
 * `newbookdefault:{userId}` = `{ newBookDefaultShared }`, never in `user:{id}`
 * (a no-CAS read-modify-write blob a stale books write could roll back); GET
 * /books merges it into its response only when the key exists.
 *
 * Check order (`.claude/rules/backend.md` → API Design): 401 (the global
 * `authMiddleware` runs before the route's param validator, so the param case
 * sends a valid token) → path param 400 `INVALID_USER_ID` → 403 (another
 * user's id) → the hourly `new-book-default` ceiling (60 per userId, charged
 * BEFORE the body is parsed) → 400 `INVALID_JSON` → 400 `INVALID_PAYLOAD`
 * (body not a plain object) → 400 `INVALID_NEW_BOOK_DEFAULT` (anything but
 * exactly 0 / 1, absent included) → write. No `user:{id}` read and no 404: a
 * user with no books record may save it. Every refusal leaves both keys
 * untouched.
 *
 * What a save must NOT do: touch `user:{id}` at all (so `lastUpdated` is not
 * bumped and a books save's `expectedLastUpdated` cannot 409 on a toggle), or
 * read / refresh any public-shelf state. The write-trail case seeds a migrated
 * owner with a live shelf, so a handler that started refreshing snapshots
 * would write `public:{LIVE_TOKEN}`.
 *
 * Request helpers: `request` sends DEV_MODE, which skips both rate-limit tiers
 * — the write trail is then the handler's own (see `helpers/kvOps.ts`).
 * `prodRequest` sends no DEV_MODE, carries the Rate Limiting binding stubs a
 * production deploy has and a unique `cf-connecting-ip` per call, so only the
 * hourly per-user KV counters can answer 429.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PATH = `/api/user/${USER1}/new-book-default`;
const SEEDED_AT = "2020-01-01T00:00:00.000Z";
const LIVE_TOKEN = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const LEGACY_TOKEN = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const HIDDEN_REF = `${USER2}:210439468000101`;

let kv: KVNamespace;
let ipCounter = 0;

interface SendOpts {
  /** Raw body string; wins over `body`. */
  raw?: string;
  body?: unknown;
  token?: string;
}

function buildInit(method: string, opts: SendOpts): RequestInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  ipCounter += 1;
  headers["cf-connecting-ip"] =
    `10.238.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  const init: RequestInit = { method, headers };
  if (opts.raw !== undefined) init.body = opts.raw;
  else if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return init;
}

/** DEV_MODE request. See the header → "Request helpers". */
function request(method: string, path: string, opts: SendOpts = {}) {
  return app.request(path, buildInit(method, opts), {
    KV: kv,
    DEV_MODE: "1",
  });
}

/** Production-shaped request. See the header → "Request helpers". */
function prodRequest(method: string, path: string, opts: SendOpts = {}) {
  return app.request(path, buildInit(method, opts), {
    KV: kv,
    ...rateLimitBindings(),
  });
}

function seededRecord(userId = USER1): UserBooksRecord {
  return {
    schemaVersion: 1,
    userId,
    displayName: "Seeded Name",
    books: [
      {
        bookId: "210439468000101",
        title: "Book 1",
        author: "Author",
        isbn: "",
        coverUrl: "",
        readmooUrl: "",
        category: "",
        isShared: BoolFlag.TRUE,
      },
    ],
    lastUpdated: SEEDED_AT,
    familyShelfPrefs: { hidden: [HIDDEN_REF], favorites: [] },
  };
}

async function seedUser(record = seededRecord()): Promise<UserBooksRecord> {
  await kv.put(kvKeys.user(record.userId), JSON.stringify(record));
  return record;
}

/** Raw stored strings, so "unchanged" means byte-identical. */
function rawUser(userId = USER1): Promise<string | null> {
  return kv.get(kvKeys.user(userId));
}

function rawSetting(userId = USER1): Promise<string | null> {
  return kv.get(kvKeys.newBookDefault(userId));
}

async function storedSetting(userId = USER1): Promise<unknown> {
  return kv.get(kvKeys.newBookDefault(userId), "json");
}

function shelf(shareToken: string): PublicShelf {
  return {
    shelfId: "11111111-1111-4111-8111-111111111111",
    shareToken,
    title: "公開書櫃",
    expiresDays: null,
    createdAt: Date.parse(SEEDED_AT),
    expiresAt: null,
    selectionMode: "all-shared",
  };
}

beforeEach(() => {
  kv = createMockKV();
});

// `watchKvOps` installs `vi.spyOn` handlers and does not clean up after itself.
afterEach(() => {
  vi.restoreAllMocks();
});

// ===== auth, param and body validation =====

describe("PUT /api/user/:id/new-book-default — auth & validation", () => {
  it("returns 400 INVALID_USER_ID for a malformed userId", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PUT", "/api/user/NOT_HEX/new-book-default", {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_USER_ID");
  });

  it("returns 401 UNAUTHORIZED without a token", async () => {
    const res = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(await rawSetting()).toBeNull();
  });

  it("returns 403 FORBIDDEN when the token belongs to another user", async () => {
    const token = await seedAuthToken(kv, USER2);
    const res = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("FORBIDDEN");
    expect(await rawSetting()).toBeNull();
    expect(await rawSetting(USER2)).toBeNull();
  });

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PUT", PATH, { raw: "{not json", token });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_JSON");
    expect(await rawSetting()).toBeNull();
  });

  it.each<{ label: string; raw: string }>([
    { label: "null", raw: "null" },
    { label: "an array", raw: "[1]" },
    { label: "an empty array", raw: "[]" },
    { label: "a number", raw: "1" },
    { label: "a string", raw: '"1"' },
    { label: "a boolean", raw: "true" },
  ])("returns 400 INVALID_PAYLOAD when the body is $label", async ({ raw }) => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PUT", PATH, { raw, token });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_PAYLOAD");
    expect(await rawSetting()).toBeNull();
  });

  it.each<{ label: string; body: Record<string, unknown> }>([
    { label: "absent", body: {} },
    { label: "true", body: { newBookDefaultShared: true } },
    { label: "false", body: { newBookDefaultShared: false } },
    { label: 'the string "1"', body: { newBookDefaultShared: "1" } },
    { label: "null", body: { newBookDefaultShared: null } },
    { label: "2", body: { newBookDefaultShared: 2 } },
    { label: "-1", body: { newBookDefaultShared: -1 } },
  ])(
    "returns 400 INVALID_NEW_BOOK_DEFAULT when the field is $label",
    async ({ body }) => {
      const token = await seedAuthToken(kv, USER1);
      // A stored setting must survive a refused save byte-for-byte.
      await kv.put(
        kvKeys.newBookDefault(USER1),
        JSON.stringify({ newBookDefaultShared: BoolFlag.TRUE }),
      );
      const before = await rawSetting();
      const res = await request("PUT", PATH, { body, token });

      expect(res.status).toBe(400);
      const json = (await res.json()) as Json;
      expect(json.error).toEqual({
        code: "INVALID_NEW_BOOK_DEFAULT",
        message: "newBookDefaultShared must be 0 or 1",
      });
      expect(await rawSetting()).toBe(before);
    },
  );
});

// ===== accepted save =====

describe("PUT /api/user/:id/new-book-default — accepted save", () => {
  it.each([BoolFlag.TRUE, BoolFlag.FALSE])(
    "stores %s in its own key and answers exactly { ok, newBookDefaultShared }",
    async (flag) => {
      const token = await seedAuthToken(kv, USER1);
      const seeded = await seedUser();
      const res = await request("PUT", PATH, {
        body: { newBookDefaultShared: flag },
        token,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { ok: true, newBookDefaultShared: flag },
      });
      expect(await storedSetting()).toEqual({ newBookDefaultShared: flag });
      // user:{id} is not touched — lastUpdated and every other field included.
      expect(await rawUser()).toBe(JSON.stringify(seeded));
    },
  );

  it("saves without a books record and does not create one", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });

    expect(res.status).toBe(200);
    expect(await storedSetting()).toEqual({
      newBookDefaultShared: BoolFlag.TRUE,
    });
    expect(await rawUser()).toBeNull();
  });

  it("stores only the flag — books, name, prefs, lastUpdated and userId in the body are ignored", async () => {
    const token = await seedAuthToken(kv, USER1);
    const seeded = await seedUser();
    const res = await request("PUT", PATH, {
      body: {
        newBookDefaultShared: BoolFlag.TRUE,
        books: [],
        displayName: "Hijacked",
        lastUpdated: "2099-01-01T00:00:00.000Z",
        familyShelfPrefs: { hidden: [], favorites: [] },
        userId: USER2,
      },
      token,
    });

    expect(res.status).toBe(200);
    expect(await storedSetting()).toEqual({
      newBookDefaultShared: BoolFlag.TRUE,
    });
    expect(await rawUser()).toBe(JSON.stringify(seeded));
    expect(await rawSetting(USER2)).toBeNull();
  });

  // See the header → "What a save must NOT do".
  it("writes only newbookdefault:{id} and reads nothing beyond the auth token", async () => {
    const token = await seedAuthToken(kv, USER1);
    const seeded = await seedUser({
      ...seededRecord(),
      publicSharing: { shelves: [shelf(LEGACY_TOKEN)] },
    });
    const pointer: PublicShelvesRecord = { shelves: [shelf(LIVE_TOKEN)] };
    await kv.put(kvKeys.publicShelves(USER1), JSON.stringify(pointer));
    const ops = watchKvOps(kv);

    const res = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });
    expect(res.status).toBe(200);
    const readKeys = ops.getKeys();
    const trail = ops.writeTrail();

    expect(trail).toEqual([`put ${kvKeys.newBookDefault(USER1)}`]);
    expect(readKeys).toEqual([kvKeys.authToken(token)]);
    expect(await kv.get(kvKeys.publicShelf(LIVE_TOKEN))).toBeNull();
    expect(await kv.get(kvKeys.publicShelf(LEGACY_TOKEN))).toBeNull();
    expect(await rawUser()).toBe(JSON.stringify(seeded));
  });

  it("round-trips 1 → 0 through GET /books, keeping 0 as an explicit value", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedUser();
    const getData = async () => {
      const res = await request("GET", `/api/user/${USER1}/books`, { token });
      expect(res.status).toBe(200);
      return ((await res.json()) as Json).data;
    };

    expect("newBookDefaultShared" in (await getData())).toBe(false);

    const on = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });
    expect(on.status).toBe(200);
    expect((await getData()).newBookDefaultShared).toBe(BoolFlag.TRUE);

    const off = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.FALSE },
      token,
    });
    expect(off.status).toBe(200);
    const after = await getData();
    expect(after.newBookDefaultShared).toBe(BoolFlag.FALSE);
    expect(after.lastUpdated).toBe(SEEDED_AT);
  });

  it("does not make a books save with the pre-toggle expectedLastUpdated conflict", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedUser();
    const toggle = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });
    expect(toggle.status).toBe(200);

    const save = await request("PUT", `/api/user/${USER1}/books`, {
      body: {
        books: [{ bookId: "210439468000101", isShared: BoolFlag.TRUE }],
        expectedLastUpdated: SEEDED_AT,
      },
      token,
    });

    expect(save.status).toBe(200);
    expect(await storedSetting()).toEqual({
      newBookDefaultShared: BoolFlag.TRUE,
    });
  });

  it("is deleted together with the account (DELETE /api/user/:id)", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedUser();
    const save = await request("PUT", PATH, {
      body: { newBookDefaultShared: BoolFlag.TRUE },
      token,
    });
    expect(save.status).toBe(200);
    expect(await rawSetting()).not.toBeNull();

    const res = await request("DELETE", `/api/user/${USER1}`, { token });

    expect(res.status).toBe(200);
    expect(await rawSetting()).toBeNull();
    expect(await rawUser()).toBeNull();
  });
});

// ===== hourly per-user ceiling (production-shaped requests) =====

describe("PUT /api/user/:id/new-book-default — per-user rate limit", () => {
  const LIMIT = 60;
  const VALID = { newBookDefaultShared: BoolFlag.TRUE };

  async function spend(
    path: string,
    count: number,
    opts: SendOpts,
    expectedStatus: number,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      const res = await prodRequest("PUT", path, opts);
      expect(res.status).toBe(expectedStatus);
    }
  }

  async function expectRateLimited(res: Response): Promise<void> {
    expect(res.status).toBe(429);
    expect(((await res.json()) as Json).error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  }

  it("returns 429 RATE_LIMITED on the 61st save within the hour", async () => {
    const token = await seedAuthToken(kv, USER1);

    await spend(PATH, LIMIT, { body: VALID, token }, 200);

    await expectRateLimited(
      await prodRequest("PUT", PATH, { body: VALID, token }),
    );
  });

  it("charges malformed bodies too, and answers 429 before the body 400", async () => {
    const token = await seedAuthToken(kv, USER1);

    await spend(PATH, LIMIT, { raw: "{not json", token }, 400);

    // Malformed AND over the limit: the 429 wins.
    await expectRateLimited(
      await prodRequest("PUT", PATH, {
        body: { newBookDefaultShared: 2 },
        token,
      }),
    );
    await expectRateLimited(
      await prodRequest("PUT", PATH, { body: VALID, token }),
    );
    expect(await rawSetting()).toBeNull();
  });

  it("is a separate counter from family-prefs and put-books", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedUser();

    await spend(
      `/api/user/${USER1}/family-prefs`,
      LIMIT,
      { body: { hidden: [HIDDEN_REF] }, token },
      200,
    );
    await expectRateLimited(
      await prodRequest("PUT", `/api/user/${USER1}/family-prefs`, {
        body: { hidden: [HIDDEN_REF] },
        token,
      }),
    );
    await spend(
      `/api/user/${USER1}/books`,
      30,
      { body: { books: [] }, token },
      200,
    );
    await expectRateLimited(
      await prodRequest("PUT", `/api/user/${USER1}/books`, {
        body: { books: [] },
        token,
      }),
    );

    const res = await prodRequest("PUT", PATH, { body: VALID, token });
    expect(res.status).toBe(200);
  });

  it("does not spend family-prefs when its own window is exhausted", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedUser();

    await spend(PATH, LIMIT, { body: VALID, token }, 200);
    await expectRateLimited(
      await prodRequest("PUT", PATH, { body: VALID, token }),
    );

    const res = await prodRequest("PUT", `/api/user/${USER1}/family-prefs`, {
      body: { hidden: [HIDDEN_REF] },
      token,
    });
    expect(res.status).toBe(200);
  });

  it("counts per userId — one user's exhausted window does not block another", async () => {
    const token1 = await seedAuthToken(kv, USER1);
    const token2 = await seedAuthToken(kv, USER2);

    await spend(PATH, LIMIT, { body: VALID, token: token1 }, 200);
    await expectRateLimited(
      await prodRequest("PUT", PATH, { body: VALID, token: token1 }),
    );

    const res = await prodRequest(
      "PUT",
      `/api/user/${USER2}/new-book-default`,
      { body: VALID, token: token2 },
    );
    expect(res.status).toBe(200);
  });

  it.each<{ label: string; tokenOf: string | null; status: number }>([
    { label: "401 (no token)", tokenOf: null, status: 401 },
    { label: "403 (another user's id)", tokenOf: USER2, status: 403 },
  ])(
    "a $label refusal charges no per-user counter",
    async ({ tokenOf, status }) => {
      const token = tokenOf ? await seedAuthToken(kv, tokenOf) : undefined;
      const ops = watchKvOps(kv);

      const res = await prodRequest("PUT", PATH, { body: VALID, token });

      expect(res.status).toBe(status);
      expect(
        ops.putKeys().filter((k) => k.startsWith("ratelimit:user:")),
      ).toEqual([]);
    },
  );

  it("charges the new-book-default counter keyed on the caller (positive companion)", async () => {
    const token = await seedAuthToken(kv, USER1);
    const ops = watchKvOps(kv);

    const res = await prodRequest("PUT", PATH, { raw: "{not json", token });

    expect(res.status).toBe(400);
    expect(
      ops.putKeys().filter((k) => k.startsWith("ratelimit:user:")),
    ).toEqual([
      expect.stringMatching(
        new RegExp(`^ratelimit:user:new-book-default:${USER1}:`),
      ),
    ]);
  });
});
