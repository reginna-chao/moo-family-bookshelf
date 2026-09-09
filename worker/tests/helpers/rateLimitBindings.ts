/**
 * Stub Cloudflare native Rate Limiting bindings for tests.
 *
 * WHY A TEST HAS TO INJECT THESE. Production deploys carry all four bindings
 * (`worker/wrangler.toml`, top level AND `[env.production]`), so every
 * per-minute limit — the per-IP tiers plus the per-userId `bookshelf`,
 * `borrow-create`, `borrow-list` and `borrow-update` scopes — is counted by the
 * platform at ZERO KV cost. A prod-mode request sent with `{ KV: kv }` alone
 * exercises the FALLBACK world instead (`bindingForWindow` returns null), which
 * differs from production in four observable ways:
 *
 * - the request pays a KV get + put per counter, so every KV-budget assertion
 *   lands on numbers no deployed Worker actually produces;
 * - the success response carries `X-RateLimit-Remaining`, which the binding
 *   path cannot report and therefore omits;
 * - a refusal answers `retryAfter` = time left in the minute bucket, where the
 *   binding path answers the whole configured period;
 * - `middleware/rateLimit.ts` logs `RATE_LIMIT_BINDING_MISSING` once per
 *   rate-limit CHECK, not once per request: the per-IP middleware and a
 *   per-minute per-userId check each log one line, so the bookshelf and
 *   borrow-* routes emit TWO per request. Either way it fills the runner
 *   output with noise that hides a real one.
 *
 * So: inject these into any request that does NOT set `DEV_MODE`, unless the
 * missing-binding fallback is precisely what the test is about (see the
 * fallback cases in `tests/unit/rateLimit.test.ts`, which pass a deliberately
 * binding-less env and spy on `console.error`).
 *
 * The stubs are pure recorders: no counting, no window, no state beyond the
 * call log. Simulating the platform's own accounting is the caller's job via
 * `decide` — the Worker no longer counts per-minute traffic itself, so a test
 * that wants a refusal asks for one.
 */

import type { RateLimitBindingName } from "../../src/utils/env";

/** One `limit()` call a stub observed. */
export interface RateLimitBindingCall {
  /** Which binding the Worker resolved for the (max, window) pair. */
  name: RateLimitBindingName;
  /** The exact key the Worker charged — the counter's identity. */
  key: string;
}

export interface RateLimitBindingStubs {
  /**
   * Spread into the env of a request: `{ KV: kv, ...bindings }`.
   *
   * Typed as the exhaustive `Record<RateLimitBindingName, RateLimit>`, so a new
   * name added to the production union is a compile error here until this
   * helper provides a stub for it.
   */
  bindings: Record<RateLimitBindingName, RateLimit>;
  /**
   * Every `limit()` call across ALL four stubs, in the order they happened.
   * Assert it with `toEqual` to pin the fixed per-request rate-limit cost the
   * KV counters used to represent.
   */
  calls: RateLimitBindingCall[];
}

/** Decides one `limit()` outcome. Default (omitted): admit everything. */
export type RateLimitDecider = (
  name: RateLimitBindingName,
  key: string,
) => boolean;

function makeStub(
  name: RateLimitBindingName,
  calls: RateLimitBindingCall[],
  decide?: RateLimitDecider,
): RateLimit {
  return {
    limit: async ({ key }) => {
      calls.push({ name, key });
      return { success: decide?.(name, key) ?? true };
    },
  };
}

/**
 * Build one fresh set of binding stubs plus their shared call log.
 *
 * Create a set per request (or per test) rather than sharing one at module
 * scope: `calls` is append-only and a shared log would accumulate across cases
 * and make `toEqual` assertions depend on execution order.
 */
export function createRateLimitBindings(
  decide?: RateLimitDecider,
): RateLimitBindingStubs {
  const calls: RateLimitBindingCall[] = [];
  // Written out rather than looped over a name array: this object literal is
  // what makes the Record exhaustiveness check bite.
  const bindings: Record<RateLimitBindingName, RateLimit> = {
    RATE_LIMIT_60_PER_MIN: makeStub("RATE_LIMIT_60_PER_MIN", calls, decide),
    RATE_LIMIT_30_PER_MIN: makeStub("RATE_LIMIT_30_PER_MIN", calls, decide),
    RATE_LIMIT_10_PER_MIN: makeStub("RATE_LIMIT_10_PER_MIN", calls, decide),
    RATE_LIMIT_3_PER_MIN: makeStub("RATE_LIMIT_3_PER_MIN", calls, decide),
  };
  return { bindings, calls };
}

/**
 * The bindings alone, for the many suites that only need their requests to
 * behave like production and never inspect the call log.
 */
export function rateLimitBindings(): Record<RateLimitBindingName, RateLimit> {
  return createRateLimitBindings().bindings;
}
