/**
 * `middleware/rateLimit.ts` — both counting paths.
 *
 * TWO WORLDS, AND EVERY CASE BELOW STATES WHICH ONE IT IS IN. Since #160 item 1
 * a per-minute limit is normally counted by Cloudflare's native Rate Limiting
 * binding at zero KV cost; a deployment that carries no binding for the limit
 * (and every hourly scope, which has none by design) still uses the old KV
 * counter. `callWithBindings` sends a request through the FIRST world — the one
 * every production deploy is in — and the bare `callHelper` through the SECOND.
 *
 * WHY THE KV CASES ARE KEPT. They are no longer "the" behaviour, they are the
 * fallback, and the fallback is what a self-hoster whose wrangler.toml predates
 * the bindings actually runs. Deleting them would leave that path untested.
 *
 * A FILE-LEVEL `console.error` SPY IS INSTALLED, because the fallback path logs
 * `RATE_LIMIT_BINDING_MISSING` on every mapped-limit request and the runner
 * output would otherwise be unreadable. It is a spy, not a filter: the cases
 * that care assert on it.
 */
import { Hono } from "hono";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  bindingForWindow,
  enforcePerUserRateLimit,
  getCallerIp,
  normalizeCallerIp,
  rateLimit,
  RATE_LIMITED_MESSAGE,
  RAW_CALLER_PREFIX,
  UNKNOWN_CALLER_KEY,
  type PerUserRateLimitOptions,
} from "../../src/middleware/rateLimit";
import type { Env, RateLimitBindingName } from "../../src/utils/env";
import { createMockKV, getPutTtl } from "../helpers/mockKv";
import { watchKvOps } from "../helpers/kvOps";
import {
  createRateLimitBindings,
  type RateLimitBindingCall,
  type RateLimitDecider,
} from "../helpers/rateLimitBindings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;
/** Installed for every case; the fallback path logs on each mapped limit. */
let errorSpy: ReturnType<typeof vi.spyOn>;

const testApp = new Hono<{ Bindings: Env }>();
testApp.post("/test", async (c) => {
  const body = await c.req.json<PerUserRateLimitOptions>();
  const res = await enforcePerUserRateLimit(c, body);
  return res ?? c.json({ ok: true });
});

/**
 * One call with a DELIBERATELY BINDING-LESS env: the KV fallback path.
 *
 * Pass `env` to add DEV_MODE or (via `callWithBindings`) the binding stubs.
 */
function callHelper(opts: PerUserRateLimitOptions, env?: Partial<Env>) {
  return testApp.request(
    "/test",
    {
      method: "POST",
      body: JSON.stringify(opts),
      headers: { "Content-Type": "application/json" },
    },
    { KV: kv, ...env },
  );
}

/** The same call in the world production runs in: all four bindings present. */
async function callWithBindings(
  opts: PerUserRateLimitOptions,
  decide?: RateLimitDecider,
  env?: Partial<Env>,
): Promise<{ res: Response; calls: RateLimitBindingCall[] }> {
  const { bindings, calls } = createRateLimitBindings(decide);
  const res = await callHelper(opts, { ...bindings, ...env });
  return { res, calls };
}

beforeEach(() => {
  kv = createMockKV();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enforcePerUserRateLimit — KV fallback (no binding configured)", () => {
  it("should bypass in dev mode without writing to KV", async () => {
    const opts = { userId: "u1", scope: "test", max: 1, windowSec: 60 };

    for (let i = 0; i < 5; i++) {
      const res = await callHelper(opts, { DEV_MODE: "1" });
      expect(res.status).toBe(200);
    }

    const keys = await kv.list();
    expect(keys.keys).toHaveLength(0);
  });

  it("should allow up to max requests", async () => {
    const opts = { userId: "u1", scope: "test", max: 5, windowSec: 60 };

    for (let i = 0; i < 5; i++) {
      const res = await callHelper(opts);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Json;
      expect(json.ok).toBe(true);
    }
  });

  it("should return 429 when exceeding max", async () => {
    const opts = { userId: "u1", scope: "test", max: 5, windowSec: 60 };

    for (let i = 0; i < 5; i++) {
      await callHelper(opts);
    }

    const res = await callHelper(opts);
    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.message).toBe("Too many requests");

    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(parseInt(retryAfter!, 10)).toBeGreaterThanOrEqual(1);

    // Body carries a sane retryAfter back-off hint (seconds) within the window,
    // consistent with the Retry-After header value.
    expect(typeof json.error.retryAfter).toBe("number");
    expect(json.error.retryAfter).toBeGreaterThanOrEqual(1);
    expect(json.error.retryAfter).toBeLessThanOrEqual(opts.windowSec);
    expect(json.error.retryAfter).toBe(parseInt(retryAfter!, 10));
  });

  it("should use separate counters for different scopes", async () => {
    const optsA = { userId: "u1", scope: "a", max: 3, windowSec: 60 };
    const optsB = { userId: "u1", scope: "b", max: 3, windowSec: 60 };

    for (let i = 0; i < 3; i++) {
      const resA = await callHelper(optsA);
      expect(resA.status).toBe(200);
      const resB = await callHelper(optsB);
      expect(resB.status).toBe(200);
    }

    // Both should be at limit now but not over
    const resA = await callHelper(optsA);
    expect(resA.status).toBe(429);
    const resB = await callHelper(optsB);
    expect(resB.status).toBe(429);
  });

  it("should reset counter after window rollover", async () => {
    vi.useFakeTimers();
    try {
      const baseTime = 1000 * 60 * 100; // arbitrary aligned start
      vi.setSystemTime(baseTime);

      const opts = { userId: "u1", scope: "test", max: 3, windowSec: 60 };

      for (let i = 0; i < 3; i++) {
        const res = await callHelper(opts);
        expect(res.status).toBe(200);
      }

      // 4th call in same window → blocked
      const blocked = await callHelper(opts);
      expect(blocked.status).toBe(429);

      // Advance past bucket boundary
      const nextBucket = (Math.floor(baseTime / 60000) + 1) * 60000;
      vi.setSystemTime(nextBucket);

      // New window → allowed again
      const res = await callHelper(opts);
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should write the counter with a TTL of twice the window", async () => {
    const opts = { userId: "u1", scope: "test", max: 5, windowSec: 60 };

    await callHelper(opts);

    const { keys } = await kv.list();
    expect(keys).toHaveLength(1);
    expect(getPutTtl(kv, keys[0].name)).toBe(opts.windowSec * 2);
  });

  it("should clamp the counter TTL up to the KV 60s floor for sub-30s windows", async () => {
    // windowSec * 2 is 20s here — below the floor real Cloudflare KV enforces.
    // Unclamped, the mock KV rejects that put, the charge throws, and an
    // admitted request turns into a 500; so the 200 below is part of the pin.
    const opts = { userId: "u1", scope: "test", max: 5, windowSec: 10 };

    const res = await callHelper(opts);
    expect(res.status).toBe(200);

    const { keys } = await kv.list();
    expect(keys).toHaveLength(1);
    // Literal 60 rather than the production constant: this assertion stays an
    // independent oracle for the platform floor instead of a tautology.
    expect(getPutTtl(kv, keys[0].name)).toBe(60);
  });

  it("should report the missing binding once per check, naming it", async () => {
    // 30/min IS in the limit -> binding table, so a deployment without the
    // field is a MISCONFIGURATION, not a design choice: the operator has to be
    // told which binding their wrangler.toml is missing.
    //
    // ONE line per rate-limit CHECK, which is one check here because this
    // harness calls `enforcePerUserRateLimit` directly. A real request to a
    // bookshelf / borrow-* route passes the per-IP middleware too and logs
    // twice.
    const opts = { userId: "u1", scope: "bookshelf", max: 30, windowSec: 60 };

    const res = await callHelper(opts);

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("RATE_LIMIT_BINDING_MISSING", {
      binding: "RATE_LIMIT_30_PER_MIN",
    });
  });

  it("should report a per-minute limit the binding table does not name", async () => {
    // 5/min is not in the table at all — that is a tier whose number was
    // changed without adding its binding, and it must be as loud as a binding
    // missing from `env`, because the request is silently back on KV either
    // way. The placeholder carries the limit, since there is no name to give.
    const res = await callHelper({
      userId: "u1",
      scope: "test",
      max: 5,
      windowSec: 60,
    });

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("RATE_LIMIT_BINDING_MISSING", {
      binding: "<unmapped:5/min>",
    });
  });

  it("should stay silent for an hourly counter, which has no binding by design", async () => {
    // The one negative companion to the two cases above: a 3600s window can
    // never be served by a binding (the platform period is 60s), so logging it
    // would drown the signal the line exists for.
    await callHelper({
      userId: "u1",
      scope: "put-books",
      max: 30,
      windowSec: 3600,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// enforcePerUserRateLimit — native Rate Limiting binding
//
// The path every deployed Worker takes for a per-minute scope: no KV counter,
// no bucket in the key, and `retryAfter` = the whole configured period because
// the binding exposes no reset time.
// ===========================================================================

/** Pinned so an hourly bucket index cannot roll over mid-case. */
const BINDING_NOW = Date.parse("2026-03-01T12:00:00.000Z");
const BINDING_MINUTE_BUCKET = Math.floor(BINDING_NOW / 60_000);
const BINDING_HOUR_BUCKET = Math.floor(BINDING_NOW / 3_600_000);

describe("enforcePerUserRateLimit — native Rate Limiting binding", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BINDING_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    { label: "60 per minute", max: 60, binding: "RATE_LIMIT_60_PER_MIN" },
    { label: "30 per minute", max: 30, binding: "RATE_LIMIT_30_PER_MIN" },
    { label: "10 per minute", max: 10, binding: "RATE_LIMIT_10_PER_MIN" },
    { label: "3 per minute", max: 3, binding: "RATE_LIMIT_3_PER_MIN" },
  ])(
    "should count a $label scope on $binding at zero KV cost",
    async ({ max, binding }) => {
      const ops = watchKvOps(kv);

      const { res, calls } = await callWithBindings({
        userId: "u1",
        scope: "bookshelf",
        max,
        windowSec: 60,
      });

      expect(res.status).toBe(200);
      // Same key shape the KV counter used, minus the window bucket the
      // binding owns — and still keyed on the caller's own id (Invariant 6).
      expect(calls).toEqual([
        { name: binding, key: "ratelimit:user:bookshelf:u1" },
      ]);
      expect(ops.getKeys()).toEqual([]);
      expect(ops.putKeys()).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("should answer a refusal with 429 and the whole window as retryAfter", async () => {
    const ops = watchKvOps(kv);

    const { res, calls } = await callWithBindings(
      { userId: "u1", scope: "bookshelf", max: 30, windowSec: 60 },
      () => false,
    );

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
    // The binding reports no reset time, so the hint is the configured period
    // rather than the time left in a bucket (which is what the KV path sends).
    expect(json.error.retryAfter).toBe(60);
    expect(res.headers.get("Retry-After")).toBe("60");

    expect(calls).toHaveLength(1);
    // A refusal costs no KV operation either — that is the point of #160.
    expect(ops.getKeys()).toEqual([]);
    expect(ops.putKeys()).toEqual([]);
  });

  it("should keep two scopes sharing one binding on separate keys", async () => {
    // 60/min is shared by the per-IP standard tier and per-userId borrow-list;
    // isolation comes from the key, never from the binding.
    const { calls } = await callWithBindings({
      userId: "u1",
      scope: "a",
      max: 60,
      windowSec: 60,
    });
    const second = await callWithBindings({
      userId: "u1",
      scope: "b",
      max: 60,
      windowSec: 60,
    });

    expect(calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: "ratelimit:user:a:u1" },
    ]);
    expect(second.calls).toEqual([
      { name: "RATE_LIMIT_60_PER_MIN", key: "ratelimit:user:b:u1" },
    ]);
  });

  it("should leave an hourly scope on the KV counter even with every binding present", async () => {
    // The binding period is 60s; an hourly ceiling has no binding to move to,
    // so `put-books` and friends deliberately keep paying their get + put.
    const ops = watchKvOps(kv);

    const { res, calls } = await callWithBindings({
      userId: "u1",
      scope: "put-books",
      max: 30,
      windowSec: 3600,
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(ops.getKeys()).toEqual([
      `ratelimit:user:put-books:u1:${BINDING_HOUR_BUCKET}`,
    ]);
    expect(ops.putKeys()).toEqual([
      `ratelimit:user:put-books:u1:${BINDING_HOUR_BUCKET}`,
    ]);
    // Not a misconfiguration — nothing to warn about.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("should leave an unmapped per-minute limit on the KV counter and say so", async () => {
    // Carrying every binding does not help a limit the table never mapped: the
    // request lands on KV and is reported, so a tier whose number was raised
    // without adding its binding cannot go unnoticed.
    const ops = watchKvOps(kv);

    const { res, calls } = await callWithBindings({
      userId: "u1",
      scope: "test",
      max: 5,
      windowSec: 60,
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(ops.putKeys()).toEqual([
      `ratelimit:user:test:u1:${BINDING_MINUTE_BUCKET}`,
    ]);
    expect(errorSpy).toHaveBeenCalledWith("RATE_LIMIT_BINDING_MISSING", {
      binding: "<unmapped:5/min>",
    });
  });

  it("should not touch the binding in dev mode", async () => {
    const { res, calls } = await callWithBindings(
      { userId: "u1", scope: "bookshelf", max: 30, windowSec: 60 },
      () => false,
      { DEV_MODE: "1" },
    );

    // DEV_MODE short-circuits before the binding lookup, so even a stub that
    // refuses everything cannot block a local request.
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    const { keys } = await kv.list();
    expect(keys).toHaveLength(0);
  });
});

// ===========================================================================
// bindingForWindow — the (limit, window) -> binding lookup
// ===========================================================================

/** Typed so `bindings[name]` below indexes the Record without a cast. */
const MAPPED_WINDOWS: {
  label: string;
  max: number;
  windowSec: number;
  name: RateLimitBindingName;
}[] = [
  { label: "60/min", max: 60, windowSec: 60, name: "RATE_LIMIT_60_PER_MIN" },
  { label: "30/min", max: 30, windowSec: 60, name: "RATE_LIMIT_30_PER_MIN" },
  { label: "10/min", max: 10, windowSec: 60, name: "RATE_LIMIT_10_PER_MIN" },
  { label: "3/min", max: 3, windowSec: 60, name: "RATE_LIMIT_3_PER_MIN" },
];

describe("bindingForWindow", () => {
  it.each(MAPPED_WINDOWS)(
    "should resolve $label to $name",
    ({ max, windowSec, name }) => {
      const { bindings } = createRateLimitBindings();
      const env: Env = { KV: kv, ...bindings };

      expect(bindingForWindow(env, max, windowSec)).toBe(bindings[name]);
    },
  );

  it.each([
    // Hourly scopes: the platform period is 60s, so none of them map.
    { label: "an hourly ceiling at a mapped limit", max: 30, windowSec: 3600 },
    { label: "an hourly ceiling at 10", max: 10, windowSec: 3600 },
    // A limit the table does not name, at the right period.
    { label: "an unmapped per-minute limit", max: 5, windowSec: 60 },
    // The platform's other permitted period is still not configured here.
    { label: "a mapped limit on a 10s window", max: 60, windowSec: 10 },
  ])("should return null for $label", ({ max, windowSec }) => {
    const { bindings } = createRateLimitBindings();
    const env: Env = { KV: kv, ...bindings };

    expect(bindingForWindow(env, max, windowSec)).toBeNull();
  });

  it("should return null for a mapped limit the deployment does not carry", () => {
    const { bindings } = createRateLimitBindings();
    // A self-hoster whose wrangler.toml predates one of the bindings.
    const partial: Env = {
      KV: kv,
      RATE_LIMIT_30_PER_MIN: bindings.RATE_LIMIT_30_PER_MIN,
      RATE_LIMIT_10_PER_MIN: bindings.RATE_LIMIT_10_PER_MIN,
      RATE_LIMIT_3_PER_MIN: bindings.RATE_LIMIT_3_PER_MIN,
    };

    expect(bindingForWindow(partial, 60, 60)).toBeNull();
    // Positive companion: the remaining three still resolve, so the null above
    // is about the missing field and not about the lookup being broken.
    expect(bindingForWindow(partial, 30, 60)).toBe(
      bindings.RATE_LIMIT_30_PER_MIN,
    );
  });

  it("should return null for every limit when no binding is configured at all", () => {
    const bare: Env = { KV: kv };

    for (const max of [60, 30, 10, 3]) {
      expect(bindingForWindow(bare, max, 60)).toBeNull();
    }
  });
});

// ===========================================================================
// Caller key normalization
//
// A residential IPv6 subscriber holds at least a /64 and privacy extensions let
// the client rotate its interface identifier at will. Keying per-caller counters
// (rate limits, verification failure accounting) on the full address would hand
// out a fresh budget on every request, so IPv6 callers are bucketed per /64.
// ===========================================================================

/** The /64 bucket of 2001:db8:1:2::/64, as rendered by normalizeCallerIp. */
const DB8_1_2_BUCKET = "2001:0db8:0001:0002::/64";

/** The all-zero /64, shared by ::, ::1 and the IPv4-compatible/translated forms. */
const ZERO_BUCKET = "0000:0000:0000:0000::/64";

describe("normalizeCallerIp", () => {
  it.each([
    {
      label: "passes IPv4 through unchanged",
      ip: "203.0.113.10",
      expected: "203.0.113.10",
    },
    {
      label: "passes the unknown-caller fallback through unchanged",
      ip: UNKNOWN_CALLER_KEY,
      expected: UNKNOWN_CALLER_KEY,
    },
    {
      label: "buckets a fully written IPv6 address on its /64",
      ip: "2001:0db8:0001:0002:0000:0000:0000:000a",
      expected: DB8_1_2_BUCKET,
    },
    {
      label: "buckets the abbreviated form of that same address identically",
      ip: "2001:db8:1:2::a",
      expected: DB8_1_2_BUCKET,
    },
    {
      label: "buckets a rotated interface identifier in that /64 identically",
      ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
      expected: DB8_1_2_BUCKET,
    },
    {
      label: "is case-insensitive and renders lowercase",
      ip: "2001:DB8:1:2::A",
      expected: DB8_1_2_BUCKET,
    },
    {
      label: "keeps a different /64 in a different bucket",
      ip: "2001:db8:1:3::a",
      expected: "2001:0db8:0001:0003::/64",
    },
    {
      label: "collapses an IPv4-mapped address to its embedded IPv4",
      ip: "::ffff:1.2.3.4",
      expected: "1.2.3.4",
    },
    {
      label: "collapses the hex form of an IPv4-mapped address too",
      ip: "::ffff:0102:0304",
      expected: "1.2.3.4",
    },
    {
      label: "buckets the unspecified address",
      ip: "::",
      expected: ZERO_BUCKET,
    },
    {
      label: "buckets loopback",
      ip: "::1",
      expected: ZERO_BUCKET,
    },
    {
      // Deprecated IPv4-compatible form. Only the ::ffff: prefix collapses to
      // the embedded IPv4, so this one stays an IPv6 address and lands in the
      // all-zero /64 next to ::1.
      label: "buckets an IPv4-compatible address in the all-zero /64",
      ip: "::1.2.3.4",
      expected: ZERO_BUCKET,
    },
    {
      // IPv4-translated form (::ffff:0:a.b.c.d): hextet 5 is 0, not 0xffff, so
      // it is not IPv4-mapped and keeps its (all-zero) /64 prefix.
      label: "buckets an IPv4-translated address in the all-zero /64",
      ip: "::ffff:0:1.2.3.4",
      expected: ZERO_BUCKET,
    },
    {
      // A dotted quad is accepted as the last group of either `::` half, so a
      // leading quad parses and occupies hextets 0-1.
      label: "buckets a literal whose leading group is a dotted quad",
      ip: "1.2.3.4::",
      expected: "0102:0304:0000:0000::/64",
    },
    {
      label: "namespaces an unparseable value under the raw prefix",
      ip: "not:an:ip",
      expected: `${RAW_CALLER_PREFIX}not:an:ip`,
    },
    {
      label: "namespaces a doubly compressed literal under the raw prefix",
      ip: "2001:db8::1::2",
      expected: `${RAW_CALLER_PREFIX}2001:db8::1::2`,
    },
    {
      label: "namespaces an incomplete literal under the raw prefix",
      ip: "2001:db8:1:2",
      expected: `${RAW_CALLER_PREFIX}2001:db8:1:2`,
    },
    {
      label: "namespaces a zone-id-suffixed literal under the raw prefix",
      ip: "fe80::1%eth0",
      expected: `${RAW_CALLER_PREFIX}fe80::1%eth0`,
    },
    {
      // No colon → treated as a non-IPv6 value and passed through. getCallerIp
      // never reaches this (an empty header falls back to UNKNOWN_CALLER_KEY).
      label: "passes the empty string through unchanged",
      ip: "",
      expected: "",
    },
  ])("$label", ({ ip, expected }) => {
    expect(normalizeCallerIp(ip)).toBe(expected);
  });

  it("should keep every normalized bucket out of the raw namespace", () => {
    const parseable = [
      "203.0.113.10",
      UNKNOWN_CALLER_KEY,
      "2001:db8:1:2::a",
      "::1",
      "::ffff:1.2.3.4",
    ];
    for (const ip of parseable) {
      expect(normalizeCallerIp(ip).startsWith(RAW_CALLER_PREFIX)).toBe(false);
    }
  });

  it("should not let a caller-supplied raw prefix alias another caller's key", () => {
    // A caller echoing the namespace back gets it applied again, so the crafted
    // value can never land on the key of the value it imitates.
    const imitated = "not:an:ip";
    const crafted = `${RAW_CALLER_PREFIX}${imitated}`;
    expect(normalizeCallerIp(crafted)).toBe(`${RAW_CALLER_PREFIX}${crafted}`);
    expect(normalizeCallerIp(crafted)).not.toBe(normalizeCallerIp(imitated));
  });

  it("should not let a crafted literal alias a real /64 bucket", () => {
    const crafted = [DB8_1_2_BUCKET, `${RAW_CALLER_PREFIX}${DB8_1_2_BUCKET}`];
    for (const ip of crafted) {
      expect(normalizeCallerIp(ip)).not.toBe(DB8_1_2_BUCKET);
    }
  });

  it("should map every spelling of one address to the same bucket", () => {
    const spellings = [
      "2001:0db8:0001:0002:0000:0000:0000:000a",
      "2001:db8:1:2::a",
      "2001:DB8:1:2::A",
      "2001:db8:1:2:1111:2222:3333:4444",
    ];
    const buckets = new Set(spellings.map(normalizeCallerIp));
    expect([...buckets]).toEqual([DB8_1_2_BUCKET]);
  });

  it("should not merge distinct callers into a shared bucket", () => {
    const distinct = [
      "203.0.113.10",
      "203.0.113.11",
      "2001:db8:1:2::a",
      "2001:db8:1:3::a",
      UNKNOWN_CALLER_KEY,
    ];
    const buckets = distinct.map(normalizeCallerIp);
    expect(new Set(buckets).size).toBe(distinct.length);
  });
});

const callerApp = new Hono<{ Bindings: Env }>();
callerApp.get("/caller", (c) => c.text(getCallerIp(c)));

async function readCallerKey(ip?: string): Promise<string> {
  const headers = ip ? { "cf-connecting-ip": ip } : undefined;
  const res = await callerApp.request("/caller", { headers }, { KV: kv });
  return res.text();
}

describe("getCallerIp", () => {
  it("should read the caller from cf-connecting-ip", async () => {
    expect(await readCallerKey("203.0.113.10")).toBe("203.0.113.10");
  });

  it("should normalize an IPv6 caller to its /64 bucket", async () => {
    expect(await readCallerKey("2001:db8:1:2::a")).toBe(DB8_1_2_BUCKET);
  });

  it("should fall back to the unknown-caller key when the header is absent", async () => {
    expect(await readCallerKey()).toBe(UNKNOWN_CALLER_KEY);
  });

  it("should ignore spoofable forwarding headers", async () => {
    const res = await callerApp.request(
      "/caller",
      { headers: { "x-forwarded-for": "203.0.113.10" } },
      { KV: kv },
    );
    expect(await res.text()).toBe(UNKNOWN_CALLER_KEY);
  });
});

// ===========================================================================
// Per-IP rateLimit middleware
//
// Every other suite runs with DEV_MODE, which short-circuits this middleware.
// These cases run WITHOUT it. They come in two halves, one per counting path:
// the KV FALLBACK first (a deployment carrying no binding for the tier's
// limit — the only place the /64 bucketing can still be observed through the
// X-RateLimit-Remaining countdown), then the NATIVE BINDING, which is what a
// deployed Worker actually runs.
// ===========================================================================

const limitedApp = new Hono<{ Bindings: Env }>();
limitedApp.use("*", rateLimit);
// A sensitive public route carries the smallest limit, so a bucket fills in
// few calls. The limit itself is read back from X-RateLimit-Limit, so these
// tests survive a change to the configured ceiling.
limitedApp.post("/api/family", (c) => c.json({ ok: true }));

/** Binding-less env on purpose: these cases pin the KV fallback. */
function callLimited(ip: string, env?: Partial<Env>) {
  return limitedApp.request(
    "/api/family",
    { method: "POST", headers: { "cf-connecting-ip": ip } },
    { KV: kv, ...env },
  );
}

/** Nth interface identifier inside 2001:db8:1:2::/64 (privacy-extension rotation). */
function rotatedInSameSubnet(n: number): string {
  return `2001:db8:1:2::${n.toString(16)}`;
}

const NEIGHBOUR_SUBNET_IP = "2001:db8:1:3::a";

describe("rateLimit middleware — KV fallback (no binding configured)", () => {
  beforeEach(() => {
    // Pin an aligned minute so the bucket cannot roll over mid-test.
    vi.useFakeTimers();
    vi.setSystemTime(1000 * 60 * 100);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Consume the whole bucket of 2001:db8:1:2::/64; returns the limit. */
  async function exhaustSameSubnetBucket(): Promise<number> {
    const first = await callLimited(rotatedInSameSubnet(0));
    expect(first.status).toBe(200);
    const limit = Number(first.headers.get("X-RateLimit-Limit"));
    expect(limit).toBeGreaterThan(0);
    for (let i = 1; i < limit; i++) {
      expect((await callLimited(rotatedInSameSubnet(i))).status).toBe(200);
    }
    return limit;
  }

  it("should share one bucket across rotated interface identifiers in the same /64", async () => {
    const first = await callLimited(rotatedInSameSubnet(0));
    expect(first.status).toBe(200);
    const limit = Number(first.headers.get("X-RateLimit-Limit"));
    expect(limit).toBeGreaterThan(0);
    expect(first.headers.get("X-RateLimit-Remaining")).toBe(String(limit - 1));

    // Each call rotates the interface identifier — the remaining budget must
    // keep counting down, i.e. all of them hit the same bucket.
    for (let i = 1; i < limit; i++) {
      const res = await callLimited(rotatedInSameSubnet(i));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe(
        String(limit - 1 - i),
      );
    }

    const blocked = await callLimited(rotatedInSameSubnet(limit));
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
  });

  it("should give a neighbouring /64 its own bucket", async () => {
    const limit = await exhaustSameSubnetBucket();
    expect((await callLimited(rotatedInSameSubnet(limit))).status).toBe(429);

    const neighbour = await callLimited(NEIGHBOUR_SUBNET_IP);
    expect(neighbour.status).toBe(200);
    expect(neighbour.headers.get("X-RateLimit-Remaining")).toBe(
      String(limit - 1),
    );
  });

  it("should bypass in dev mode without writing to KV", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await callLimited(rotatedInSameSubnet(0), { DEV_MODE: "1" });
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    }

    const { keys } = await kv.list();
    expect(keys).toHaveLength(0);
  });
});

// ===========================================================================
// Per-IP rateLimit middleware — native Rate Limiting binding
//
// One app carrying a route from each of the four counters, so the tier -> key
// mapping is exercised end to end rather than only through
// `rateLimitBucketFor` (whose own classification cases live in
// tests/unit/securityHardening.test.ts).
// ===========================================================================

const tierApp = new Hono<{ Bindings: Env }>();
tierApp.use("*", rateLimit);
tierApp.post("/api/family", (c) => c.json({ ok: true }));
tierApp.post("/api/auth/lookup", (c) => c.json({ ok: true }));
tierApp.get("/api/public/:shareToken", (c) => c.json({ ok: true }));
tierApp.get("/api/family/:id/members", (c) => c.json({ ok: true }));

const TIER_IP = "203.0.113.7";

async function callTier(
  method: string,
  path: string,
  opts: { ip?: string; decide?: RateLimitDecider; env?: Partial<Env> } = {},
): Promise<{ res: Response; calls: RateLimitBindingCall[] }> {
  const { bindings, calls } = createRateLimitBindings(opts.decide);
  const res = await tierApp.request(
    path,
    { method, headers: { "cf-connecting-ip": opts.ip ?? TIER_IP } },
    { KV: kv, ...bindings, ...opts.env },
  );
  return { res, calls };
}

describe("rateLimit middleware — native Rate Limiting binding", () => {
  // Literal prefixes and limits, deliberately: they are the independent oracle
  // for what production charges. `rateLimitBucketFor` is where they come from,
  // so asserting against it here would only restate the implementation.
  it.each([
    {
      label: "standard tier",
      method: "GET",
      path: "/api/family/abcd-1234/members",
      binding: "RATE_LIMIT_60_PER_MIN",
      prefix: "ratelimit",
      limit: "60",
    },
    {
      label: "public tier",
      method: "GET",
      path: "/api/public/beefcafebeefcafebeefcafebeefcafe",
      binding: "RATE_LIMIT_10_PER_MIN",
      prefix: "ratelimit:pub",
      limit: "10",
    },
    {
      label: "sensitive tier, onboarding bucket",
      method: "POST",
      path: "/api/family",
      binding: "RATE_LIMIT_3_PER_MIN",
      prefix: "ratelimit:sens",
      limit: "3",
    },
    {
      label: "sensitive tier, lookup bucket",
      method: "POST",
      path: "/api/auth/lookup",
      binding: "RATE_LIMIT_3_PER_MIN",
      prefix: "ratelimit:sens:lookup",
      limit: "3",
    },
  ])(
    "should charge the $label to $binding under $prefix, at zero KV cost",
    async ({ method, path, binding, prefix, limit }) => {
      const ops = watchKvOps(kv);

      const { res, calls } = await callTier(method, path);

      expect(res.status).toBe(200);
      // No minute bucket in the key: the binding owns the window.
      expect(calls).toEqual([{ name: binding, key: `${prefix}:${TIER_IP}` }]);
      expect(res.headers.get("X-RateLimit-Limit")).toBe(limit);
      // The binding exposes no remaining count, so the header is omitted —
      // unlike the KV fallback, which still sends it.
      expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
      expect(ops.getKeys()).toEqual([]);
      expect(ops.putKeys()).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("should keep the two sensitive buckets on separate keys at the same limit", async () => {
    // One clean onboarding spends two lookups plus one create within a minute
    // from one address; a shared counter would refuse the first typo retry.
    const onboarding = await callTier("POST", "/api/family");
    const lookup = await callTier("POST", "/api/auth/lookup");

    expect(onboarding.calls[0].name).toBe(lookup.calls[0].name);
    expect(onboarding.calls[0].key).not.toBe(lookup.calls[0].key);
  });

  it("should answer a refusal with 429, a period-long retryAfter and no KV op", async () => {
    const ops = watchKvOps(kv);

    const { res, calls } = await callTier("POST", "/api/family", {
      decide: () => false,
    });

    expect(res.status).toBe(429);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(json.error.message).toBe(RATE_LIMITED_MESSAGE);
    // The configured period, not the time left in a minute bucket: the binding
    // reports no reset time.
    expect(json.error.retryAfter).toBe(60);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();

    expect(calls).toEqual([
      { name: "RATE_LIMIT_3_PER_MIN", key: `ratelimit:sens:${TIER_IP}` },
    ]);
    // A refused request must not cost anything at all.
    expect(ops.getKeys()).toEqual([]);
    expect(ops.putKeys()).toEqual([]);
  });

  it("should still bucket an IPv6 caller on its /64 in the binding key", async () => {
    // The rotation bypass the /64 normalization closes exists on this path too
    // — the binding counts whatever key it is handed.
    const first = await callTier("POST", "/api/family", {
      ip: "2001:db8:1:2::a",
    });
    const rotated = await callTier("POST", "/api/family", {
      ip: "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
    });
    const neighbour = await callTier("POST", "/api/family", {
      ip: "2001:db8:1:3::a",
    });

    expect(first.calls).toEqual([
      { name: "RATE_LIMIT_3_PER_MIN", key: `ratelimit:sens:${DB8_1_2_BUCKET}` },
    ]);
    expect(rotated.calls[0].key).toBe(first.calls[0].key);
    expect(neighbour.calls[0].key).not.toBe(first.calls[0].key);
  });

  it("should fall back to the unknown-caller key when no client IP is trusted", async () => {
    const { bindings, calls } = createRateLimitBindings();
    const res = await tierApp.request(
      "/api/family",
      { method: "POST", headers: { "x-forwarded-for": "203.0.113.10" } },
      { KV: kv, ...bindings },
    );

    expect(res.status).toBe(200);
    // The spoofable header is ignored, so every such caller shares one bucket.
    expect(calls).toEqual([
      {
        name: "RATE_LIMIT_3_PER_MIN",
        key: `ratelimit:sens:${UNKNOWN_CALLER_KEY}`,
      },
    ]);
  });

  it("should not touch the binding in dev mode", async () => {
    const { res, calls } = await callTier("POST", "/api/family", {
      decide: () => false,
      env: { DEV_MODE: "1" },
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    const { keys } = await kv.list();
    expect(keys).toHaveLength(0);
  });
});
