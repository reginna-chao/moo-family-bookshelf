import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import app from "../../src/index";
import { userSettingsRoutes } from "../../src/routes/userSettings";
import type { Env } from "../../src/utils/env";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { authTokenKey, seedAuthToken } from "../helpers/auth";
import { rateLimitBindings } from "../helpers/rateLimitBindings";
import {
  BoolFlag,
  kvKeys,
  type AccountSettingsRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

/**
 * `GET` / `PATCH /api/user/:id/settings` (#460) — the four settings that follow
 * the account across browsers and the PWA, stored in their own key
 * `settings:{userId}` (no TTL): `syncArchived` / `storePageChipEnabled`
 * (`BoolFlag`), `autoSyncInterval` (daily / weekly / monthly / never) and
 * `floatingIconSize` (small / medium / large / icon). Every field is optional;
 * absent means "never set on the server".
 *
 * GET order: 401 → 403 (another user's id) → one read → `200 { data: {
 * settings } }`. No record and a corrupt record both read as `{}`, an invalid
 * stored field is dropped and the valid ones survive — the handler never
 * answers 404 itself, because clients read `NOT_FOUND` as "this Worker
 * predates the route". GET has no per-user ceiling.
 *
 * PATCH order (`.claude/rules/backend.md` → API Design): 401 → 403 → the hourly
 * `account-settings` ceiling (60 per authenticated caller, charged BEFORE the
 * body is parsed) → 400 `INVALID_JSON` → 400 `INVALID_PAYLOAD` (body not a
 * plain object) → 400 `INVALID_SETTINGS` (`settings` / `ifAbsent` present but
 * not an object, a known field with an invalid value, or no known field in
 * either; the message names the field) → one read → merge → at most ONE put,
 * none when nothing changed → `200 { data: { ok: true, settings: <merged> } }`.
 * `settings` overwrites; `ifAbsent` fills only a field the stored record lacks
 * and `settings` does not name. Unknown keys are ignored.
 *
 * Request helpers: `request` sends DEV_MODE, which skips both rate-limit tiers,
 * so a write trail is the handler's own (see `helpers/kvOps.ts`). `prodRequest`
 * sends no DEV_MODE, carries the Rate Limiting binding stubs a production
 * deploy has and a unique `cf-connecting-ip` per call, so only the hourly
 * per-user KV counters can answer 429.
 *
 * THE HANDLERS' OWN 401. Through the real app the global `authMiddleware`
 * answers a token-less request first ("Authorization header required"). Each
 * handler still checks for an authenticated caller itself, so the route stays
 * closed if it is ever mounted outside that middleware; the "handler guard"
 * cases mount `userSettingsRoutes` alone to pin that check.
 *
 * NOT COVERED HERE. `createMockKV()` is instantly consistent and does not model
 * KV's one-write-per-second limit per key, so "at most one put per request" is
 * pinned as a count of puts, not as the platform behaviour it protects against;
 * the cross-colo overwrite residual cannot be reproduced either.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PATH = `/api/user/${USER1}/settings`;
const SETTINGS_KEY = kvKeys.accountSettings(USER1);
const FULL: AccountSettingsRecord = {
  syncArchived: BoolFlag.TRUE,
  autoSyncInterval: "weekly",
  storePageChipEnabled: BoolFlag.FALSE,
  floatingIconSize: "icon",
};

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
    `10.46.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

async function seedSettings(value: string, userId = USER1): Promise<void> {
  await kv.put(kvKeys.accountSettings(userId), value);
}

function rawSettings(userId = USER1): Promise<string | null> {
  return kv.get(kvKeys.accountSettings(userId));
}

function storedSettings(userId = USER1): Promise<unknown> {
  return kv.get(kvKeys.accountSettings(userId), "json");
}

function patch(token: string, body: unknown) {
  return request("PATCH", PATH, { body, token });
}

async function patchData(token: string, body: unknown): Promise<Json> {
  const res = await patch(token, body);
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data;
}

async function getSettings(token: string): Promise<Json> {
  const res = await request("GET", PATH, { token });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).data.settings;
}

beforeEach(() => {
  kv = createMockKV();
});

// `watchKvOps` installs `vi.spyOn` handlers and does not clean up after itself.
afterEach(() => {
  vi.restoreAllMocks();
});

// ===== GET =====

describe("GET /api/user/:id/settings", () => {
  it("answers { settings: {} } when the user never saved a setting", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("GET", PATH, { token });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { settings: {} } });
  });

  it("returns every stored field, BoolFlag values as 0 / 1", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(JSON.stringify(FULL));

    const settings = await getSettings(token);

    expect(settings).toEqual(FULL);
    expect(settings.syncArchived).toBe(BoolFlag.TRUE);
    expect(settings.storePageChipEnabled).toBe(BoolFlag.FALSE);
  });

  it("reads only the token and settings:{id}, writes nothing and charges no per-user counter", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(JSON.stringify(FULL));
    const ops = watchKvOps(kv);

    const res = await prodRequest("GET", PATH, { token });

    expect(res.status).toBe(200);
    expect(ops.getKeys()).toEqual([await authTokenKey(token), SETTINGS_KEY]);
    expect(ops.writeTrail()).toEqual([]);
  });

  it.each<{ label: string; stored: string }>([
    { label: "unparseable JSON", stored: "{not json" },
    { label: "JSON null", stored: "null" },
    { label: "an array", stored: '[{"syncArchived":1}]' },
    { label: "a number", stored: "1" },
    { label: "a string", stored: '"weekly"' },
    { label: "a boolean", stored: "true" },
    { label: "an empty string", stored: "" },
  ])(
    "reads a corrupt stored value ($label) as {} and never throws",
    async ({ stored }) => {
      const token = await seedAuthToken(kv, USER1);
      await seedSettings(stored);

      const res = await request("GET", PATH, { token });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { settings: {} } });
      // A read never repairs or deletes what it found.
      expect(await rawSettings()).toBe(stored);
    },
  );

  it("drops an invalid stored field and keeps the valid ones", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(
      JSON.stringify({
        syncArchived: true,
        autoSyncInterval: "weekly",
        storePageChipEnabled: 2,
        floatingIconSize: "huge",
        injected: "<script>",
      }),
    );

    expect(await getSettings(token)).toEqual({ autoSyncInterval: "weekly" });
  });

  it("returns 401 UNAUTHORIZED without a token, reading no settings", async () => {
    await seedSettings(JSON.stringify(FULL));
    const ops = watchKvOps(kv);

    const res = await request("GET", PATH);

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(ops.getKeys()).not.toContain(SETTINGS_KEY);
  });

  it("returns 403 FORBIDDEN for another user's id, reading no settings", async () => {
    const token = await seedAuthToken(kv, USER2);
    await seedSettings(JSON.stringify(FULL));
    const ops = watchKvOps(kv);

    const res = await request("GET", PATH, { token });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(json)).not.toContain("weekly");
    expect(ops.getKeys()).not.toContain(SETTINGS_KEY);
  });

  it("keeps each user's settings apart", async () => {
    const token1 = await seedAuthToken(kv, USER1);
    const token2 = await seedAuthToken(kv, USER2);
    await seedSettings(JSON.stringify(FULL));

    expect(await getSettings(token1)).toEqual(FULL);
    const res = await request("GET", `/api/user/${USER2}/settings`, {
      token: token2,
    });
    expect(await res.json()).toEqual({ data: { settings: {} } });
  });
});

// ===== The handlers' own 401, outside the global middleware =====

describe("GET / PATCH /api/user/:id/settings — handler guard", () => {
  // See the header → "THE HANDLERS' OWN 401".
  const bare = new Hono<{ Bindings: Env }>().route(
    "/api/user",
    userSettingsRoutes,
  );

  it.each(["GET", "PATCH"])(
    "%s answers 401 UNAUTHORIZED with no authenticated caller and touches no KV key",
    async (method) => {
      const ops = watchKvOps(kv);
      const init: RequestInit = { method };
      if (method === "PATCH") {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify({ settings: { syncArchived: 1 } });
      }

      const res = await bare.request(PATH, init, { KV: kv });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
      expect(ops.getKeys()).toEqual([]);
      expect(ops.writeTrail()).toEqual([]);
    },
  );
});

// ===== PATCH: auth and body validation =====

describe("PATCH /api/user/:id/settings — auth & validation", () => {
  const VALID = { settings: { syncArchived: BoolFlag.TRUE } };

  it("returns 401 UNAUTHORIZED without a token and writes nothing", async () => {
    const res = await request("PATCH", PATH, { body: VALID });

    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.code).toBe("UNAUTHORIZED");
    expect(await rawSettings()).toBeNull();
  });

  it("returns 403 FORBIDDEN when the token belongs to another user and writes neither key", async () => {
    const token = await seedAuthToken(kv, USER2);
    const res = await request("PATCH", PATH, { body: VALID, token });

    expect(res.status).toBe(403);
    expect(((await res.json()) as Json).error.code).toBe("FORBIDDEN");
    expect(await rawSettings()).toBeNull();
    expect(await rawSettings(USER2)).toBeNull();
  });

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PATCH", PATH, { raw: "{not json", token });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error.code).toBe("INVALID_JSON");
    expect(await rawSettings()).toBeNull();
  });

  it.each<{ label: string; raw: string }>([
    { label: "null", raw: "null" },
    { label: "an array", raw: '[{"settings":{"syncArchived":1}}]' },
    { label: "an empty array", raw: "[]" },
    { label: "a number", raw: "1" },
    { label: "a string", raw: '"settings"' },
    { label: "a boolean", raw: "true" },
  ])("returns 400 INVALID_PAYLOAD when the body is $label", async ({ raw }) => {
    const token = await seedAuthToken(kv, USER1);
    const res = await request("PATCH", PATH, { raw, token });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error).toEqual({
      code: "INVALID_PAYLOAD",
      message: "Request body must be an object",
    });
    expect(await rawSettings()).toBeNull();
  });

  const NO_KNOWN_FIELD =
    "settings or ifAbsent must carry at least one known setting";

  it.each<{ label: string; body: unknown; message: string }>([
    {
      label: "settings is an array",
      body: { settings: [{ syncArchived: 1 }] },
      message: "settings must be an object",
    },
    {
      label: "settings is a string",
      body: { settings: "weekly" },
      message: "settings must be an object",
    },
    {
      label: "settings is null",
      body: { settings: null },
      message: "settings must be an object",
    },
    {
      label: "ifAbsent is a number",
      body: { settings: { syncArchived: 1 }, ifAbsent: 1 },
      message: "ifAbsent must be an object",
    },
    {
      label: "ifAbsent is null",
      body: { ifAbsent: null },
      message: "ifAbsent must be an object",
    },
    {
      label: "autoSyncInterval is not one of the four values",
      body: { settings: { autoSyncInterval: "hourly" } },
      message: "settings.autoSyncInterval has an invalid value",
    },
    {
      label: "floatingIconSize is not one of the four values",
      body: { settings: { floatingIconSize: "huge" } },
      message: "settings.floatingIconSize has an invalid value",
    },
    {
      label: "syncArchived is true instead of 1",
      body: { settings: { syncArchived: true } },
      message: "settings.syncArchived has an invalid value",
    },
    {
      label: "storePageChipEnabled is false instead of 0",
      body: { settings: { storePageChipEnabled: false } },
      message: "settings.storePageChipEnabled has an invalid value",
    },
    {
      label: 'syncArchived is the string "1"',
      body: { settings: { syncArchived: "1" } },
      message: "settings.syncArchived has an invalid value",
    },
    {
      label: "syncArchived is 2",
      body: { settings: { syncArchived: 2 } },
      message: "settings.syncArchived has an invalid value",
    },
    {
      label: "a known field is null",
      body: { settings: { floatingIconSize: null } },
      message: "settings.floatingIconSize has an invalid value",
    },
    {
      label: "an ifAbsent field is invalid next to a valid settings field",
      body: {
        settings: { syncArchived: 1 },
        ifAbsent: { autoSyncInterval: "Daily" },
      },
      message: "ifAbsent.autoSyncInterval has an invalid value",
    },
    {
      label: "one invalid field next to valid ones",
      body: { settings: { syncArchived: 1, storePageChipEnabled: true } },
      message: "settings.storePageChipEnabled has an invalid value",
    },
    { label: "the body is {}", body: {}, message: NO_KNOWN_FIELD },
    {
      label: "both objects are empty",
      body: { settings: {}, ifAbsent: {} },
      message: NO_KNOWN_FIELD,
    },
    {
      label: "only unknown keys are sent",
      body: { settings: { theme: "dark" }, ifAbsent: { bookSort: "title" } },
      message: NO_KNOWN_FIELD,
    },
    {
      label: "the fields sit at the top level",
      body: { syncArchived: 1 },
      message: NO_KNOWN_FIELD,
    },
  ])("returns 400 INVALID_SETTINGS when $label", async ({ body, message }) => {
    const token = await seedAuthToken(kv, USER1);
    // A stored record must survive a refused save byte-for-byte.
    const before = JSON.stringify({ floatingIconSize: "small" });
    await seedSettings(before);
    const ops = watchKvOps(kv);

    const res = await request("PATCH", PATH, { body, token });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Json).error).toEqual({
      code: "INVALID_SETTINGS",
      message,
    });
    expect(await rawSettings()).toBe(before);
    expect(ops.writeTrail()).toEqual([]);
  });
});

// ===== PATCH: merge and write =====

describe("PATCH /api/user/:id/settings — merge", () => {
  it("stores the first save in its own key, with no TTL, and answers { ok, settings }", async () => {
    const token = await seedAuthToken(kv, USER1);
    const res = await patch(token, {
      settings: { syncArchived: BoolFlag.TRUE },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { ok: true, settings: { syncArchived: BoolFlag.TRUE } },
    });
    expect(await storedSettings()).toEqual({ syncArchived: BoolFlag.TRUE });
    expect(getPutTtl(kv, SETTINGS_KEY)).toBeUndefined();
  });

  it("overwrites only the fields settings names and keeps the others", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(JSON.stringify(FULL));

    const data = await patchData(token, {
      settings: { autoSyncInterval: "never", floatingIconSize: "large" },
    });

    const expected = {
      ...FULL,
      autoSyncInterval: "never",
      floatingIconSize: "large",
    };
    expect(data).toEqual({ ok: true, settings: expected });
    expect(await storedSettings()).toEqual(expected);
  });

  it.each<{ label: string; from: BoolFlag; to: BoolFlag }>([
    { label: "1 → 0", from: BoolFlag.TRUE, to: BoolFlag.FALSE },
    { label: "0 → 1", from: BoolFlag.FALSE, to: BoolFlag.TRUE },
  ])(
    "keeps 0 as an explicit value when a BoolFlag goes $label",
    async ({ from, to }) => {
      const token = await seedAuthToken(kv, USER1);
      await seedSettings(JSON.stringify({ storePageChipEnabled: from }));

      await patchData(token, { settings: { storePageChipEnabled: to } });

      expect(await storedSettings()).toEqual({ storePageChipEnabled: to });
      expect(await getSettings(token)).toEqual({ storePageChipEnabled: to });
    },
  );

  it("fills a missing field from ifAbsent and leaves an existing one", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(JSON.stringify({ syncArchived: BoolFlag.FALSE }));

    const data = await patchData(token, {
      ifAbsent: {
        syncArchived: BoolFlag.TRUE,
        storePageChipEnabled: BoolFlag.TRUE,
      },
    });

    const expected = {
      syncArchived: BoolFlag.FALSE,
      storePageChipEnabled: BoolFlag.TRUE,
    };
    expect(data.settings).toEqual(expected);
    expect(await storedSettings()).toEqual(expected);
  });

  it("lets settings win when both objects name the same field", async () => {
    const token = await seedAuthToken(kv, USER1);

    const data = await patchData(token, {
      settings: { floatingIconSize: "small" },
      ifAbsent: { floatingIconSize: "icon", autoSyncInterval: "monthly" },
    });

    const expected = { floatingIconSize: "small", autoSyncInterval: "monthly" };
    expect(data.settings).toEqual(expected);
    expect(await storedSettings()).toEqual(expected);
  });

  it("lets settings win over ifAbsent on a field the server already holds", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(JSON.stringify({ floatingIconSize: "medium" }));

    const data = await patchData(token, {
      settings: { floatingIconSize: "small" },
      ifAbsent: { floatingIconSize: "icon" },
    });

    expect(data.settings).toEqual({ floatingIconSize: "small" });
  });

  it("ignores unknown keys at every level and stores none of them", async () => {
    const token = await seedAuthToken(kv, USER1);

    const data = await patchData(token, {
      settings: { syncArchived: BoolFlag.TRUE, theme: "dark" },
      ifAbsent: { bookSort: "title" },
      userId: USER2,
      extra: true,
    });

    expect(data).toEqual({
      ok: true,
      settings: { syncArchived: BoolFlag.TRUE },
    });
    expect(await rawSettings()).toBe(
      JSON.stringify({ syncArchived: BoolFlag.TRUE }),
    );
    expect(await rawSettings(USER2)).toBeNull();
  });

  it("writes settings:{id} exactly once for a body carrying both objects, and touches no other key", async () => {
    const token = await seedAuthToken(kv, USER1);
    const books: UserBooksRecord = {
      schemaVersion: 1,
      userId: USER1,
      displayName: "Seeded",
      books: [],
      lastUpdated: "2020-01-01T00:00:00.000Z",
    };
    await kv.put(kvKeys.user(USER1), JSON.stringify(books));
    await kv.put(
      kvKeys.newBookDefault(USER1),
      JSON.stringify({ newBookDefaultShared: BoolFlag.TRUE }),
    );
    const ops = watchKvOps(kv);

    const res = await patch(token, {
      settings: { syncArchived: BoolFlag.TRUE, autoSyncInterval: "daily" },
      ifAbsent: { floatingIconSize: "large", storePageChipEnabled: 0 },
    });

    expect(res.status).toBe(200);
    expect(ops.writeTrail()).toEqual([`put ${SETTINGS_KEY}`]);
    // Token, the one settings read, then accountDeletionGuard's mark read.
    expect(ops.getKeys()).toEqual([
      await authTokenKey(token),
      SETTINGS_KEY,
      kvKeys.accountDeleting(USER1),
    ]);
    expect(await kv.get(kvKeys.user(USER1))).toBe(JSON.stringify(books));
  });

  it.each<{ label: string; stored: AccountSettingsRecord; body: unknown }>([
    {
      label: "settings repeats the stored value",
      stored: { syncArchived: BoolFlag.TRUE },
      body: { settings: { syncArchived: BoolFlag.TRUE } },
    },
    {
      label: "ifAbsent names only fields the server holds",
      stored: FULL,
      body: {
        ifAbsent: {
          syncArchived: BoolFlag.FALSE,
          autoSyncInterval: "daily",
          storePageChipEnabled: BoolFlag.TRUE,
          floatingIconSize: "small",
        },
      },
    },
    {
      label: "settings repeats a stored 0 and ifAbsent loses to it",
      stored: { storePageChipEnabled: BoolFlag.FALSE },
      body: {
        settings: { storePageChipEnabled: BoolFlag.FALSE },
        ifAbsent: { storePageChipEnabled: BoolFlag.TRUE },
      },
    },
  ])(
    "writes nothing when $label, and still answers the merged record",
    async ({ stored, body }) => {
      const token = await seedAuthToken(kv, USER1);
      const raw = JSON.stringify(stored);
      await seedSettings(raw);
      const ops = watchKvOps(kv);

      const data = await patchData(token, body);

      expect(data).toEqual({ ok: true, settings: stored });
      expect(ops.writeTrail()).toEqual([]);
      expect(await rawSettings()).toBe(raw);
    },
  );

  it.each<{ label: string; stored: string }>([
    { label: "unparseable JSON", stored: "{not json" },
    { label: "an array", stored: "[1]" },
    { label: "JSON null", stored: "null" },
  ])(
    "replaces a corrupt stored value ($label) with a clean record",
    async ({ stored }) => {
      const token = await seedAuthToken(kv, USER1);
      await seedSettings(stored);

      const data = await patchData(token, {
        ifAbsent: { syncArchived: BoolFlag.TRUE },
      });

      expect(data.settings).toEqual({ syncArchived: BoolFlag.TRUE });
      expect(await storedSettings()).toEqual({ syncArchived: BoolFlag.TRUE });
    },
  );

  it("treats an invalid stored field as absent: ifAbsent fills it and the valid fields survive", async () => {
    const token = await seedAuthToken(kv, USER1);
    await seedSettings(
      JSON.stringify({
        syncArchived: true,
        autoSyncInterval: "weekly",
        floatingIconSize: "huge",
      }),
    );

    const data = await patchData(token, {
      ifAbsent: { syncArchived: BoolFlag.FALSE },
    });

    const expected = {
      syncArchived: BoolFlag.FALSE,
      autoSyncInterval: "weekly",
    };
    expect(data.settings).toEqual(expected);
    // The rewrite carries no invalid or unknown field forward.
    expect(await rawSettings()).toBe(JSON.stringify(expected));
  });

  it("round-trips through GET with the values a client sent", async () => {
    const token = await seedAuthToken(kv, USER1);

    await patchData(token, { settings: FULL });

    expect(await getSettings(token)).toEqual(FULL);
  });

  it("is deleted together with the account (DELETE /api/user/:id)", async () => {
    const token = await seedAuthToken(kv, USER1);
    await kv.put(
      kvKeys.user(USER1),
      JSON.stringify({ userId: USER1, books: [] }),
    );
    await patchData(token, { settings: FULL });
    expect(await rawSettings()).not.toBeNull();

    const res = await request("DELETE", `/api/user/${USER1}`, { token });

    expect(res.status).toBe(200);
    expect(await rawSettings()).toBeNull();
    expect(await kv.get(kvKeys.user(USER1))).toBeNull();
  });
});

// ===== PATCH: hourly per-user ceiling (production-shaped requests) =====

describe("PATCH /api/user/:id/settings — per-user rate limit", () => {
  const LIMIT = 60;
  const VALID = { settings: { syncArchived: BoolFlag.TRUE } };

  async function spend(
    path: string,
    method: string,
    count: number,
    opts: SendOpts,
    expectedStatus: number,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      const res = await prodRequest(method, path, opts);
      expect(res.status).toBe(expectedStatus);
    }
  }

  async function expectRateLimited(res: Response): Promise<void> {
    expect(res.status).toBe(429);
    expect(((await res.json()) as Json).error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  }

  it("returns 429 RATE_LIMITED on the 61st PATCH within the hour, unchanged saves included", async () => {
    const token = await seedAuthToken(kv, USER1);

    // The first save writes; the other 59 change nothing and still spend a slot.
    await spend(PATH, "PATCH", LIMIT, { body: VALID, token }, 200);

    await expectRateLimited(
      await prodRequest("PATCH", PATH, {
        body: { settings: { syncArchived: BoolFlag.FALSE } },
        token,
      }),
    );
    expect(await storedSettings()).toEqual({ syncArchived: BoolFlag.TRUE });
  });

  it("charges malformed bodies too, and answers 429 before the body 400", async () => {
    const token = await seedAuthToken(kv, USER1);

    await spend(PATH, "PATCH", LIMIT, { raw: "{not json", token }, 400);

    // Malformed AND over the limit: the 429 wins.
    await expectRateLimited(
      await prodRequest("PATCH", PATH, {
        body: { settings: { syncArchived: true } },
        token,
      }),
    );
    await expectRateLimited(
      await prodRequest("PATCH", PATH, { body: VALID, token }),
    );
    expect(await rawSettings()).toBeNull();
  });

  it("leaves GET unlimited per user once the PATCH window is spent", async () => {
    const token = await seedAuthToken(kv, USER1);

    await spend(PATH, "PATCH", LIMIT, { body: VALID, token }, 200);
    await expectRateLimited(
      await prodRequest("PATCH", PATH, { body: VALID, token }),
    );

    await spend(PATH, "GET", LIMIT + 1, { token }, 200);
  });

  it("is a separate counter from new-book-default", async () => {
    const token = await seedAuthToken(kv, USER1);
    const newBookDefault = `/api/user/${USER1}/new-book-default`;
    const flag = { newBookDefaultShared: BoolFlag.TRUE };

    await spend(newBookDefault, "PUT", LIMIT, { body: flag, token }, 200);
    await expectRateLimited(
      await prodRequest("PUT", newBookDefault, { body: flag, token }),
    );
    const own = await prodRequest("PATCH", PATH, { body: VALID, token });
    expect(own.status).toBe(200);

    await spend(PATH, "PATCH", LIMIT - 1, { body: VALID, token }, 200);
    await expectRateLimited(
      await prodRequest("PATCH", PATH, { body: VALID, token }),
    );
  });

  it("counts per userId — one user's exhausted window does not block another", async () => {
    const token1 = await seedAuthToken(kv, USER1);
    const token2 = await seedAuthToken(kv, USER2);

    await spend(PATH, "PATCH", LIMIT, { body: VALID, token: token1 }, 200);
    await expectRateLimited(
      await prodRequest("PATCH", PATH, { body: VALID, token: token1 }),
    );

    const res = await prodRequest("PATCH", `/api/user/${USER2}/settings`, {
      body: VALID,
      token: token2,
    });
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

      const res = await prodRequest("PATCH", PATH, { body: VALID, token });

      expect(res.status).toBe(status);
      expect(
        ops.putKeys().filter((k) => k.startsWith("ratelimit:user:")),
      ).toEqual([]);
    },
  );

  it("charges the account-settings counter keyed on the caller (positive companion)", async () => {
    const token = await seedAuthToken(kv, USER1);
    const ops = watchKvOps(kv);

    const res = await prodRequest("PATCH", PATH, { raw: "{not json", token });

    expect(res.status).toBe(400);
    expect(
      ops.putKeys().filter((k) => k.startsWith("ratelimit:user:")),
    ).toEqual([
      expect.stringMatching(
        new RegExp(`^ratelimit:user:account-settings:${USER1}:\\d+$`),
      ),
    ]);
  });
});
