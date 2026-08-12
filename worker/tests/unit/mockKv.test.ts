/**
 * Unit tests for the KV mock itself (`tests/helpers/mockKv.ts`).
 *
 * The mock is test INFRASTRUCTURE, but it is also the only place the whole
 * worker suite can catch a TTL that real Cloudflare KV would refuse: KV rejects
 * any `expirationTtl` below 60 seconds, and production computes some TTLs
 * dynamically (see `src/services/publicShelf.ts`). If the mock accepted such a
 * value, a regression there would pass every unit test and only surface against
 * the real platform. These tests pin that guard — including which of its two
 * rejection reasons fires, since only the sub-60 floor mirrors the platform
 * while the integer requirement is deliberately stricter (real KV truncates) —
 * and pin the boundary of what the mock deliberately does NOT do (it never
 * simulates expiry).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMockKV, getPutTtl } from "../helpers/mockKv";

const KEY = "verifyfail:alice:join";
const OTHER_KEY = "otp:alice";

let kv: KVNamespace;

beforeEach(() => {
  // A fresh mock per test: state lives entirely on the instance (the TTL
  // registry is a WeakMap keyed by it), so nothing leaks between tests.
  kv = createMockKV();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Resolves with the rejection reason, or fails if the promise resolved. */
async function captureRejection(put: Promise<unknown>): Promise<Error> {
  const error: unknown = await put.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/**
 * Asserts the put was rejected by the guard named in `reason`, not by some
 * other error. The two guards carry different messages on purpose: the sub-60
 * floor mirrors real KV ("must be at least 60"), while the integer rule is the
 * mock being stricter than the platform ("must be an integer").
 */
async function expectRejectedPut(
  put: Promise<unknown>,
  reason: string,
): Promise<void> {
  const error = await captureRejection(put);
  expect(error.message).toContain(reason);
}

describe("createMockKV put", () => {
  it.each([
    ["one second below the 60s minimum", 59, "must be at least 60"],
    ["zero", 0, "must be at least 60"],
    ["a negative TTL", -1, "must be at least 60"],
    ["a non-integer TTL below the minimum", 59.5, "must be an integer"],
    ["a non-integer TTL above the minimum", 120.5, "must be an integer"],
    ["NaN", Number.NaN, "must be an integer"],
  ])("rejects an expirationTtl of %s", async (_desc, ttl, reason) => {
    await expectRejectedPut(
      kv.put(KEY, "value", { expirationTtl: ttl }),
      reason,
    );
  });

  it("reports a sub-minimum TTL the way real KV reports it", async () => {
    const error = await captureRejection(
      kv.put(KEY, "value", { expirationTtl: 30 }),
    );

    // Miniflare's own message ("Invalid expiration_ttl of 30. Expiration TTL
    // must be at least 60.") contains these same two substrings, so a suite
    // asserting on them keeps passing if this mock is swapped for Miniflare —
    // for positive sub-60 TTLs like this one only; 0 / negative / NaN get a
    // different Miniflare message (see the guard's comment in helpers/mockKv.ts).
    expect(error.message).toContain("Invalid expiration_ttl");
    expect(error.message).toContain("must be at least 60");
    expect(error.message).toContain(KEY);
    expect(error.message).toContain("30");
  });

  it("reports a non-integer TTL as the mock's own stricter rule", async () => {
    const error = await captureRejection(
      kv.put(KEY, "value", { expirationTtl: 120.5 }),
    );

    // NOT a platform message: real KV would parseInt() 120.5 to 120 and accept
    // it, so this rejection must not claim the floor was the problem.
    expect(error.message).toContain("must be an integer");
    expect(error.message).not.toContain("Invalid expiration_ttl");
    expect(error.message).toContain(KEY);
    expect(error.message).toContain("120.5");
  });

  // Both guards run before any mutation, so each rejection reason is checked
  // against the same state-untouched expectations.
  it.each([
    ["a sub-minimum TTL", 30, "must be at least 60"],
    ["a non-integer TTL", 59.5, "must be an integer"],
  ])(
    "leaves the mock untouched when a put is rejected for %s",
    async (_desc, ttl, reason) => {
      await expectRejectedPut(
        kv.put(KEY, "value", { expirationTtl: ttl }),
        reason,
      );

      expect(await kv.get(KEY)).toBeNull();
      expect(getPutTtl(kv, KEY)).toBeUndefined();
      expect((await kv.list()).keys).toHaveLength(0);
    },
  );

  it.each([
    ["a sub-minimum TTL", 59, "must be at least 60"],
    ["a non-integer TTL", 120.5, "must be an integer"],
  ])(
    "keeps the previous value and recorded TTL when a put rejected for %s overwrites an existing key",
    async (_desc, ttl, reason) => {
      await kv.put(KEY, "original", { expirationTtl: 900 });

      await expectRejectedPut(
        kv.put(KEY, "overwritten", { expirationTtl: ttl }),
        reason,
      );

      expect(await kv.get(KEY)).toBe("original");
      expect(getPutTtl(kv, KEY)).toBe(900);
    },
  );

  it("does not affect other keys when a put is rejected", async () => {
    await kv.put(OTHER_KEY, "kept", { expirationTtl: 300 });

    await expectRejectedPut(
      kv.put(KEY, "value", { expirationTtl: 1 }),
      "must be at least 60",
    );

    expect(await kv.get(OTHER_KEY)).toBe("kept");
    expect(getPutTtl(kv, OTHER_KEY)).toBe(300);
  });

  it.each([
    ["exactly the 60s minimum", 60],
    ["just above the minimum", 120],
    ["a seven-day TTL", 7 * 86_400],
  ])("stores the value and records an expirationTtl of %s", async (_d, ttl) => {
    await kv.put(KEY, "value", { expirationTtl: ttl });

    expect(await kv.get(KEY)).toBe("value");
    expect(getPutTtl(kv, KEY)).toBe(ttl);
  });

  it("stores the value with no recorded TTL when no options are passed", async () => {
    await kv.put(KEY, "value");

    expect(await kv.get(KEY)).toBe("value");
    expect(getPutTtl(kv, KEY)).toBeUndefined();
  });

  it("stores the value with no recorded TTL when expirationTtl is undefined", async () => {
    await kv.put(KEY, "value", { expirationTtl: undefined });

    expect(await kv.get(KEY)).toBe("value");
    expect(getPutTtl(kv, KEY)).toBeUndefined();
  });

  it("ignores an absolute expiration instead of validating it", async () => {
    // Pins the MOCK's documented behavior, NOT the platform's: only
    // `expirationTtl` is understood, so an absolute `expiration` (epoch
    // seconds) is neither validated nor recorded. Real Cloudflare KV does
    // validate it — `expiration` must be at least 60s in the future, so
    // `expiration: 1` would come back a 400. The mock deliberately models none
    // of that because no production code passes an absolute `expiration`; if
    // that changes, this gap has to close before the caller can be trusted.
    await kv.put(KEY, "value", { expiration: 1 });

    expect(await kv.get(KEY)).toBe("value");
    expect(getPutTtl(kv, KEY)).toBeUndefined();
  });
});

describe("createMockKV TTL recording", () => {
  it("clears both the value and the recorded TTL on delete", async () => {
    await kv.put(KEY, "value", { expirationTtl: 900 });

    await kv.delete(KEY);

    expect(await kv.get(KEY)).toBeNull();
    expect(getPutTtl(kv, KEY)).toBeUndefined();
  });

  it("records the TTL of the most recent put", async () => {
    await kv.put(KEY, "first", { expirationTtl: 900 });
    await kv.put(KEY, "second", { expirationTtl: 60 });

    expect(await kv.get(KEY)).toBe("second");
    expect(getPutTtl(kv, KEY)).toBe(60);
  });

  it("keeps an accepted key readable past its TTL — expiry is never simulated", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await kv.put(KEY, "value", { expirationTtl: 60 });

    vi.setSystemTime(Date.now() + 365 * 86_400_000);

    expect(await kv.get(KEY)).toBe("value");
    expect(getPutTtl(kv, KEY)).toBe(60);
  });
});

describe("getPutTtl", () => {
  it("returns undefined for a key that was never written", () => {
    expect(getPutTtl(kv, "never:written")).toBeUndefined();
  });

  it("does not report TTLs recorded on a different mock instance", async () => {
    const otherKv = createMockKV();

    await otherKv.put(KEY, "value", { expirationTtl: 900 });

    expect(getPutTtl(kv, KEY)).toBeUndefined();
    expect(getPutTtl(otherKv, KEY)).toBe(900);
  });
});
