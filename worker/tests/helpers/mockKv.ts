/**
 * Simple in-memory KV mock for unit/integration tests.
 *
 * TTLs are VALIDATED and RECORDED, never SIMULATED.
 *
 * VALIDATED: Cloudflare KV's 60-second floor on `expirationTtl` IS enforced at
 * put time — a sub-60 TTL throws, mirroring real KV's rejection ("Invalid
 * expiration_ttl, must be at least 60"). So production code that computes a TTL
 * dynamically and lands below the floor fails the unit suite here, instead of
 * passing locally and only blowing up against real KV.
 *
 * STRICTER THAN THE PLATFORM: a non-integer `expirationTtl` also throws, and
 * that part mirrors nothing — workerd / Miniflare run parseInt() BEFORE the
 * floor check, so real KV would truncate 120.5 to 120 and accept it. The mock
 * refuses it so production TTL arithmetic has to round explicitly rather than
 * lean on a silent truncation.
 *
 * Never SIMULATED: expiry itself still does not happen. A key whose put was
 * ACCEPTED stays readable forever in this mock, no matter how much wall-clock
 * or fake time passes. Tests that need expiry semantics must delete the key
 * themselves (or use Miniflare); asserting "the entry expired" against this
 * mock is not possible.
 */

/**
 * Cloudflare KV rejects any `expirationTtl` below 60 seconds.
 *
 * Deliberately duplicated from `src/kv/schema.ts` (whose exported
 * `KV_MIN_TTL_SECONDS` production shares between `services/publicShelf.ts` and
 * `middleware/rateLimit.ts` for its TTL arithmetic) rather than imported: this
 * helper models the PLATFORM's constraint and must stay an independent oracle.
 * Sharing one constant would let a wrong value in production silently redefine
 * what the test infrastructure accepts, so the check would pass by construction.
 */
const KV_MIN_TTL_SECONDS = 60;

/**
 * Subset of `KVNamespacePutOptions` the mock understands.
 *
 * Only `expirationTtl` is recognized. An absolute `expiration` (epoch seconds)
 * is silently ignored — `getPutTtl` would read back `undefined` for such a
 * write, which looks identical to "written with no TTL at all". Real KV DOES
 * validate `expiration` too (it must be at least 60s in the future); the mock
 * deliberately models none of that, because no production code passes it.
 */
interface MockPutOptions {
  expirationTtl?: number;
}

/**
 * Per-mock record of the `expirationTtl` passed on the LAST `put` of each key.
 *
 * Kept in a side table (keyed by the mock instance) rather than on the returned
 * object so `createMockKV()` keeps its exact `KVNamespace` shape — every
 * existing suite is unaffected. Entries die with the mock instance.
 */
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
      // Validated BEFORE any mutation: real KV rejects the whole write, so a
      // refused put must leave this mock byte-identical to its prior state
      // (no value written, no TTL recorded, previous entry preserved).
      if (ttl !== undefined) {
        // Stricter than the platform on purpose: workerd / Miniflare run
        // parseInt() before the floor check, so 120.5 would be truncated to 120
        // and ACCEPTED. This mock refuses it so production TTL arithmetic must
        // round explicitly. Nothing in real KV emits this message.
        if (!Number.isInteger(ttl)) {
          throw new Error(
            `KV put "${key}": expirationTtl must be an integer (got ${ttl})`,
          );
        }
        // Miniflare reports a TTL in 1..59 as "Invalid expiration_ttl of 30.
        // Expiration TTL must be at least 60." — it carries both the
        // "Invalid expiration_ttl" and "must be at least 60" substrings used
        // below, so assertions on them survive swapping this mock for
        // Miniflare. NOT so for 0 / negative / NaN: Miniflare short-circuits
        // those to "Please specify integer greater than 0." before the floor
        // check, so the zero and negative rows in mockKv.test.ts pin this
        // mock only.
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
