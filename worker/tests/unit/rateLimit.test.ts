import { Hono } from "hono";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  enforcePerUserRateLimit,
  getCallerIp,
  normalizeCallerIp,
  rateLimit,
  RAW_CALLER_PREFIX,
  UNKNOWN_CALLER_KEY,
} from "../../src/middleware/rateLimit";
import type { Env } from "../../src/utils/env";
import { createMockKV, getPutTtl } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const testApp = new Hono<{ Bindings: Env }>();
testApp.post("/test", async (c) => {
  const body = await c.req.json<{
    userId: string;
    scope: string;
    max: number;
    windowSec: number;
  }>();
  const res = await enforcePerUserRateLimit(c, body);
  return res ?? c.json({ ok: true });
});

function callHelper(
  opts: { userId: string; scope: string; max: number; windowSec: number },
  env?: Partial<Env>,
) {
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

beforeEach(() => {
  kv = createMockKV();
});

describe("enforcePerUserRateLimit", () => {
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
// These cases run WITHOUT it, pinning the /64 granularity as the middleware's
// intended bucketing rather than an accident of normalizeCallerIp.
// ===========================================================================

const limitedApp = new Hono<{ Bindings: Env }>();
limitedApp.use("*", rateLimit);
// A sensitive public route carries the smallest limit, so a bucket fills in
// few calls. The limit itself is read back from X-RateLimit-Limit, so these
// tests survive a change to the configured ceiling.
limitedApp.post("/api/family", (c) => c.json({ ok: true }));

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

describe("rateLimit middleware", () => {
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
