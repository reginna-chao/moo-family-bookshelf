/**
 * Simple in-memory KV mock for unit/integration tests.
 */
export function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    get: async (key: string, opts?: unknown) => {
      const value = store.get(key) ?? null;
      if (opts === "json" && value) return JSON.parse(value);
      if (typeof opts === "object" && opts !== null && "type" in opts) {
        const o = opts as { type: string };
        if (o.type === "json" && value) return JSON.parse(value);
      }
      return value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
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
}
