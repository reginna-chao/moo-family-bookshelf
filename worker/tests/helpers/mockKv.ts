/** In-memory KV mock for unit/integration tests — its TTL contract is in
 *  `createMockKV`'s JSDoc and `.claude/rules/test.md` → Mock Policy. */

/** Cloudflare KV's 60s `expirationTtl` floor — an independent copy of production's
 *  constant, see `createMockKV`'s JSDoc → "Independent oracle". */
const KV_MIN_TTL_SECONDS = 60;

/** The one `put` option the mock understands; an absolute `expiration` is ignored
 *  (see `createMockKV`'s JSDoc → "`expiration` is not modelled"). */
interface MockPutOptions {
  expirationTtl?: number;
}

/** Per-mock `expirationTtl` of each key's LAST `put`, in a side table so `createMockKV()`
 *  keeps its exact `KVNamespace` shape; entries die with the mock instance. */
const ttlRegistry = new WeakMap<KVNamespace, Map<string, number | undefined>>();

/**
 * TTL (seconds) the given key was last SUCCESSFULLY written with, or `undefined`
 * when the key was never written, was deleted, or was written without
 * `expirationTtl` (including a write that passed only an absolute `expiration`).
 * A REJECTED put changes nothing — a key that already carried a recorded TTL
 * keeps it. Those `undefined` cases are indistinguishable here — `undefined`
 * alone does not prove "no write happened", so pair the assertion with a `get`
 * when that distinction matters.
 *
 * Use it to assert that self-expiring records (e.g. `verifyfail:*`, `otp:*`)
 * really carry a TTL — an entry that silently loses its TTL would grow
 * unbounded in KV and keep stale state alive forever. It reports only what was
 * PASSED to `put`; the mock never expires anything, so a recorded TTL says
 * nothing about the key still being readable.
 */
export function getPutTtl(kv: KVNamespace, key: string): number | undefined {
  return ttlRegistry.get(kv)?.get(key);
}

/**
 * Simple in-memory KV mock for unit/integration tests. TTLs are VALIDATED and
 * RECORDED, never SIMULATED; the policy side (expiry never happens, a test that
 * needs "expired" deletes the key itself, sub-minimum stubs) lives in
 * `.claude/rules/test.md` → Mock Policy.
 *
 * VALIDATED: Cloudflare KV's 60-second floor on `expirationTtl` IS enforced at
 * put time — a sub-60 TTL throws, mirroring real KV's rejection ("Invalid
 * expiration_ttl, must be at least 60"). So production code that computes a TTL
 * dynamically and lands below the floor fails the unit suite here, instead of
 * passing locally and only blowing up against real KV. Validation runs BEFORE
 * any mutation: real KV rejects the whole write, so a refused put leaves the
 * mock byte-identical to its prior state (no value written, no TTL recorded,
 * previous entry preserved).
 *
 * STRICTER THAN THE PLATFORM: a non-integer `expirationTtl` also throws, and
 * that part mirrors nothing — workerd / Miniflare run parseInt() BEFORE the
 * floor check, so real KV would truncate 120.5 to 120 and accept it. The mock
 * refuses it so production TTL arithmetic has to round explicitly rather than
 * lean on a silent truncation. Nothing in real KV emits that error message.
 *
 * Miniflare messages: Miniflare reports a TTL in 1..59 as "Invalid
 * expiration_ttl of 30. Expiration TTL must be at least 60." — it carries both
 * the "Invalid expiration_ttl" and "must be at least 60" substrings the floor
 * error uses, so assertions on them survive swapping this mock for Miniflare.
 * NOT so for 0 / negative / NaN: Miniflare short-circuits those to "Please
 * specify integer greater than 0." before the floor check, so the zero and
 * negative rows in mockKv.test.ts pin this mock only.
 *
 * Never SIMULATED: expiry itself does not happen. A key whose put was ACCEPTED
 * stays readable forever in this mock, no matter how much wall-clock or fake
 * time passes; asserting "the entry expired" against it is not possible.
 *
 * Independent oracle: `KV_MIN_TTL_SECONDS` is deliberately duplicated from
 * `src/kv/schema.ts` (whose exported `KV_MIN_TTL_SECONDS` production shares
 * between `services/publicShelf.ts` and `middleware/rateLimit.ts` for its TTL
 * arithmetic) rather than imported: this helper models the PLATFORM's
 * constraint. Sharing one constant would let a wrong value in production
 * silently redefine what the test infrastructure accepts, so the check would
 * pass by construction.
 *
 * `expiration` is not modelled: only `expirationTtl` is recognized. An absolute
 * `expiration` (epoch seconds) is silently ignored — `getPutTtl` would read back
 * `undefined` for such a write, which looks identical to "written with no TTL
 * at all". Real KV DOES validate `expiration` too (it must be at least 60s in
 * the future); the mock deliberately models none of that, because no
 * production code passes it.
 */
export function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();

  const kv = {
    get: async (key: string, opts?: unknown) => {
      const value = store.get(key) ?? null;
      if (opts === "json" && value) return JSON.parse(value);
      if (typeof opts === "object" && opts !== null && "type" in opts) {
        const o = opts as { type: string };
        if (o.type === "json" && value) return JSON.parse(value);
      }
      return value;
    },
    put: async (key: string, value: string, opts?: MockPutOptions) => {
      const ttl = opts?.expirationTtl;
      // Validated BEFORE any mutation: a refused put leaves the mock unchanged.
      if (ttl !== undefined) {
        // Stricter than the platform (real KV truncates 120.5 to 120). See the
        // `createMockKV` JSDoc → "STRICTER THAN THE PLATFORM".
        if (!Number.isInteger(ttl)) {
          throw new Error(
            `KV put "${key}": expirationTtl must be an integer (got ${ttl})`,
          );
        }
        // Substrings shared with Miniflare's 1..59 message (not its 0 / negative one).
        // See the `createMockKV` JSDoc → "Miniflare messages".
        if (ttl < KV_MIN_TTL_SECONDS) {
          throw new Error(
            `KV put "${key}": Invalid expiration_ttl, must be at least ${KV_MIN_TTL_SECONDS} (got ${ttl})`,
          );
        }
      }
      store.set(key, value);
      ttls.set(key, ttl);
    },
    delete: async (key: string) => {
      store.delete(key);
      ttls.delete(key);
    },
    list: async () => {
      const keys = [...store.keys()].map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
    getWithMetadata: async () => ({
      value: null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;

  ttlRegistry.set(kv, ttls);
  return kv;
}
