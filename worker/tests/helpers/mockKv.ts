/**
 * Simple in-memory KV mock for unit/integration tests.
 *
 * TTLs are RECORDED, never SIMULATED: a key written with `expirationTtl` stays
 * readable forever in this mock, no matter how much wall-clock or fake time
 * passes. Tests that need expiry semantics must delete the key themselves (or
 * use Miniflare); asserting "the entry expired" against this mock is not
 * possible.
 */

/**
 * Subset of `KVNamespacePutOptions` the mock understands.
 *
 * Only `expirationTtl` is recognized. An absolute `expiration` (epoch seconds)
 * is silently ignored — `getPutTtl` would read back `undefined` for such a
 * write, which looks identical to "written with no TTL at all".
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
 * TTL (seconds) the given key was last written with, or `undefined` when the
 * key was never written, was deleted, or was written without `expirationTtl`
 * (including a write that passed only an absolute `expiration`). Those cases
 * are indistinguishable here — `undefined` alone does not prove "no write
 * happened", so pair the assertion with a `get` when that distinction matters.
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
      store.set(key, value);
      ttls.set(key, opts?.expirationTtl);
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
