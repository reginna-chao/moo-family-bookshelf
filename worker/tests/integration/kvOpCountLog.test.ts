/**
 * The `kv_ops` telemetry line — `withKvOpCounting` in
 * src/middleware/kvOpCounting.ts (issue #163).
 *
 * WHAT THIS FILE IS. The middleware wraps `c.env.KV` in a counting Proxy and
 * emits ONE `console.log` per `/api/*` request carrying that request's KV
 * operation tally. This suite pins the three things that make the line usable
 * and safe, none of which the budget suites cover:
 *
 * 1. SHAPE — the logged object is exactly
 *    `{ event, method, route, status, reads, writes, deletes }` and nothing
 *    else, so a Workers Logs query written against it keeps working.
 * 2. NO SECRETS — `route` is the route PATTERN, never `c.req.path`. The raw
 *    path carries `:shareToken` (which IS a public shelf's capability) and
 *    `:id` (an email-derived userId, or a familyId that doubles as the sync
 *    code). A log sink is not a place any of those may land.
 * 3. IT NEVER BREAKS A REQUEST — one line per request on the success, 401 and
 *    500 paths alike, and a log sink that throws is swallowed.
 *
 * WHY THE COUNTS ARE ASSERTED AGAINST A RECORDER, NOT LITERALS. `watchKvOps`
 * observes the same namespace the Proxy wraps, so `reads`/`writes`/`deletes`
 * are compared to what the request ACTUALLY did. The literal numbers (7/2/0 for
 * a two-member bookshelf today) belong to tests/integration/budget/, which
 * exists to fail when they change; issue #160 is expected to lower them, and
 * this file must stay green when it does — it is about the line being CORRECT,
 * not about the bill being small.
 *
 * Caveat on that equality: `watchKvOps` spies `get` / `put` / `delete`, while
 * the Proxy also counts `getWithMetadata` as a read. Nothing on these paths
 * calls it, so the two agree today. A future handler that does would fail these
 * assertions — which is the right signal: it means the recorder no longer sees
 * everything the counter counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import { createRateLimitBindings } from "../helpers/rateLimitBindings";
import { seedAuthToken } from "../helpers/auth";
import {
  BoolFlag,
  kvKeys,
  type BookEntry,
  type FamilyRecord,
  type RawFamilyRecord,
  type UserBooksRecord,
} from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

/**
 * Deliberately distinctive so the "the familyId is not in the log" assertions
 * cannot pass vacuously: no substring of it occurs in the route pattern, the
 * method, or any other field of the line.
 */
const FAMILY_ID = "kvlg-9wq3";
const BOOKSHELF_PATH = `/api/family/${FAMILY_ID}/bookshelf`;
const BOOKSHELF_ROUTE = "/api/family/:id/bookshelf";

/** Valid 32-hex share token, never seeded — equally distinctive. */
const SHARE_TOKEN = "beefcafebeefcafebeefcafebeefcafe";
const PUBLIC_ROUTE = "/api/public/:shareToken";

/** One IP per case: the per-IP counter must never be shared between cases. */
const IP = {
  happyPath: "10.63.0.1",
  routePattern: "10.63.0.2",
  shareToken: "10.63.0.3",
  errorPath: "10.63.0.4",
  devMode: "10.63.0.5",
  throwingSink: "10.63.0.6",
  unauthorized: "10.63.0.7",
} as const;

let kv: KVNamespace;

/**
 * The one log line under test. Mirrors the object literal in
 * src/middleware/kvOpCounting.ts.
 */
interface KvOpsLine {
  event: "kv_ops";
  method: string;
  route: string;
  status: number;
  reads: number;
  writes: number;
  deletes: number;
}

/** The `console.log` spy surface read below — structural, no vitest types. */
interface LogSpy {
  mock: { calls: unknown[][] };
}

function isKvOpsLine(value: unknown): value is KvOpsLine {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { event?: unknown }).event === "kv_ops"
  );
}

/**
 * Every kv_ops line the spy saw, in order. Filtered rather than assumed: an
 * unrelated `console.log` added elsewhere in the pipeline must not turn these
 * assertions into a false failure — nor be mistaken for the telemetry line.
 */
function kvOpsLines(spy: LogSpy): KvOpsLine[] {
  return spy.mock.calls.map((call) => call[0]).filter(isKvOpsLine);
}

function silenceConsoleLog(): LogSpy {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function sharedBook(bookId: string): BookEntry {
  return {
    bookId,
    title: `Title ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

/** Two-member family, both with a shared book, plus the caller's auth token. */
async function seedFamilyWithBooks(): Promise<string> {
  const family: FamilyRecord = {
    familyId: FAMILY_ID,
    ownerId: USER1,
    members: [
      { userId: USER1, displayName: "Alice", canLend: BoolFlag.TRUE },
      { userId: USER2, displayName: "Bob", canLend: BoolFlag.TRUE },
    ],
    maxMembers: 2,
    createdAt: new Date().toISOString(),
  };
  await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(family));
  for (const userId of [USER1, USER2]) {
    await kv.put(kvKeys.member(userId), FAMILY_ID);
    const record: UserBooksRecord = {
      schemaVersion: 1,
      userId,
      displayName: userId === USER1 ? "Alice" : "Bob",
      books: [sharedBook(`book-${userId.slice(0, 4)}`)],
      lastUpdated: new Date().toISOString(),
    };
    await kv.put(kvKeys.user(userId), JSON.stringify(record));
  }
  return seedAuthToken(kv, USER1);
}

/**
 * The Rate Limiting bindings a production deploy carries. Injected on every
 * request here so the counts this suite compares against the recorder are the
 * ones a deployed Worker produces, not the KV-fallback ones.
 */
function bookshelfRequest(
  ip: string,
  opts?: { token?: string; devMode?: boolean },
) {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const { bindings } = createRateLimitBindings();
  const env = opts?.devMode
    ? { KV: kv, DEV_MODE: "1", ...bindings }
    : { KV: kv, ...bindings };
  return app.request(BOOKSHELF_PATH, { method: "GET", headers }, env);
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withKvOpCounting — kv_ops telemetry line", () => {
  it("logs one line per request carrying every field and the request's real KV counts", async () => {
    const token = await seedFamilyWithBooks();

    const logSpy = silenceConsoleLog();
    // AFTER seeding, so only the request under test is recorded.
    const ops = watchKvOps(kv);

    const res = await bookshelfRequest(IP.happyPath, { token });

    expect(res.status).toBe(200);

    const lines = kvOpsLines(logSpy);
    expect(lines).toHaveLength(1);
    // `toEqual` on the COMPLETE object is the point: it pins the field set as
    // well as the values, so a stray `path` (or any other addition) fails here.
    expect(lines[0]).toEqual({
      event: "kv_ops",
      method: "GET",
      route: BOOKSHELF_ROUTE,
      status: 200,
      reads: ops.getKeys().length,
      writes: ops.putKeys().length,
      deletes: ops.deleteKeys().length,
    });

    // Non-vacuity for `reads`: without traffic that equality would be 0 === 0.
    // `writes` and `deletes` genuinely ARE zero here since #160 item 1 moved
    // both rate-limit counters onto the platform — a read-only aggregation now
    // writes nothing. Non-zero write/delete counting is pinned directly on
    // `createCountingKv` in tests/unit/kvOpCounting.test.ts.
    expect(ops.getKeys().length).toBeGreaterThan(0);
    expect(ops.putKeys()).toEqual([]);
  });

  it("logs the route pattern, never the raw path that carries the familyId", async () => {
    const token = await seedFamilyWithBooks();
    const logSpy = silenceConsoleLog();

    const res = await bookshelfRequest(IP.routePattern, { token });

    expect(res.status).toBe(200);
    const [entry] = kvOpsLines(logSpy);
    // Positive companion for the two negatives below: without it they would
    // stay green if `route` silently became "" or an unrelated string.
    expect(entry.route).toBe(BOOKSHELF_ROUTE);
    expect(entry.route).not.toContain(FAMILY_ID);
    // A familyId IS the sync code (`moo-{familyId}`): anyone who reads it can
    // ask to join. It must not reach a log sink, in `route` or anywhere else.
    expect(JSON.stringify(entry)).not.toContain(FAMILY_ID);
  });

  it("keeps a public share token out of the line entirely", async () => {
    const logSpy = silenceConsoleLog();

    // No seed: an unknown-but-well-formed token stops at the snapshot miss.
    const { bindings } = createRateLimitBindings();
    const res = await app.request(
      `/api/public/${SHARE_TOKEN}`,
      { method: "GET", headers: { "cf-connecting-ip": IP.shareToken } },
      { KV: kv, ...bindings },
    );

    expect(res.status).toBe(404);
    const lines = kvOpsLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0].route).toBe(PUBLIC_ROUTE);
    expect(lines[0].status).toBe(404);
    // The share token IS the shelf's only secret — holding it is what grants
    // read access. Logging the raw path would hand every shelf to the sink.
    expect(JSON.stringify(lines[0])).not.toContain(SHARE_TOKEN);
  });

  it("still logs the operations that ran before a handler threw", async () => {
    const token = await seedAuthToken(kv, USER1);
    await kv.put(kvKeys.member(USER1), FAMILY_ID);
    // An empty members array makes `normalizeFamilyRecord` (src/kv/schema.ts)
    // throw, so the request dies inside the handler AFTER several KV reads and
    // is turned into a 500 by app.onError.
    const corrupted: RawFamilyRecord = {
      familyId: FAMILY_ID,
      members: [],
      createdAt: new Date().toISOString(),
    };
    await kv.put(kvKeys.family(FAMILY_ID), JSON.stringify(corrupted));

    const logSpy = silenceConsoleLog();
    // app.onError logs "Unhandled error:" — silenced so the runner output stays
    // readable; asserted below so the 500 is proven to come from that path.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ops = watchKvOps(kv);

    const res = await bookshelfRequest(IP.errorPath, { token });

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();

    const lines = kvOpsLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: "kv_ops",
      method: "GET",
      route: BOOKSHELF_ROUTE,
      status: 500,
      reads: ops.getKeys().length,
      writes: ops.putKeys().length,
      deletes: ops.deleteKeys().length,
    });

    // The point of the case: work already paid for before the throw is still
    // reported. The family read is the last one the handler reached. Only
    // `reads` can carry that proof — the request performs no write at all now
    // that #160 item 1 moved both rate-limit counters onto the platform.
    expect(ops.getKeys()).toContain(kvKeys.family(FAMILY_ID));
    expect(lines[0].reads).toBeGreaterThan(0);
  });

  it("logs the line under DEV_MODE too, with the counts dev mode actually incurs", async () => {
    const token = await seedFamilyWithBooks();

    const logSpy = silenceConsoleLog();
    const ops = watchKvOps(kv);

    const res = await bookshelfRequest(IP.devMode, { token, devMode: true });

    expect(res.status).toBe(200);
    const lines = kvOpsLines(logSpy);
    expect(lines).toHaveLength(1);
    // Lower than the first case by both rate-limit layers' get+put: the per-IP
    // `rateLimit` and `enforcePerUserRateLimit` short-circuit under DEV_MODE.
    // Asserted against the recorder rather than a literal, so this stays a
    // statement about the line being correct for what ran.
    expect(lines[0]).toEqual({
      event: "kv_ops",
      method: "GET",
      route: BOOKSHELF_ROUTE,
      status: 200,
      reads: ops.getKeys().length,
      writes: ops.putKeys().length,
      deletes: ops.deleteKeys().length,
    });
    expect(ops.getKeys().length).toBeGreaterThan(0);
  });

  it("serves the request normally when the log sink itself throws", async () => {
    const token = await seedFamilyWithBooks();
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink down");
    });

    const res = await bookshelfRequest(IP.throwingSink, { token });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { members: unknown[] } };
    expect(body.data.members).toHaveLength(2);
  });

  it("logs exactly one line for a request auth rejects before the handler runs", async () => {
    await seedFamilyWithBooks();

    const logSpy = silenceConsoleLog();
    const ops = watchKvOps(kv);

    // No Authorization header: authMiddleware answers 401 without calling
    // next(), so the handler never runs.
    const res = await bookshelfRequest(IP.unauthorized);

    expect(res.status).toBe(401);
    const lines = kvOpsLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      event: "kv_ops",
      method: "GET",
      route: BOOKSHELF_ROUTE,
      // Verified by running it, not assumed: the route is still the HANDLER's
      // pattern even though a middleware answered. Hono resolves the whole
      // matched-handler chain when it dispatches, so `routePath(c, -1)` names
      // the registered route regardless of which link short-circuited.
      status: 401,
      reads: ops.getKeys().length,
      writes: ops.putKeys().length,
      deletes: ops.deleteKeys().length,
    });

    // Corroborates the comment above: the aggregation never ran. Since #160
    // item 1 the per-IP tier costs no KV operation, and authMiddleware refuses
    // a request with no Authorization header before its own `token:` read — so
    // a stranger's rejected request is now logged as a genuine 0/0/0.
    expect(ops.getKeys()).toEqual([]);
    expect(ops.putKeys()).toEqual([]);
    // (Positive companion for that negative: the error-path case asserts the
    // family key IS read when the handler does run.)
    expect(ops.getKeys()).not.toContain(kvKeys.family(FAMILY_ID));
  });
});
