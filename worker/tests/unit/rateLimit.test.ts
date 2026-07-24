import { Hono } from "hono";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { enforcePerUserRateLimit } from "../../src/middleware/rateLimit";
import type { Env } from "../../src/utils/env";
import { createMockKV } from "../helpers/mockKv";

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

  // KV TTL cannot be verified with in-memory mock (no metadata support).
  // Production behavior: expirationTtl = windowSec * 2.
});
