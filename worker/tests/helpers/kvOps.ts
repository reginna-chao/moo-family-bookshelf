/** KV key-touch recorder — usage, scope caveats and the `writeTrail` ordering
 *  semantics are in the `watchKvOps` / `KvOpLog` JSDoc. */
import { vi } from "vitest";

/** The spy surface this helper reads — structural, so all four ops share it. */
interface SpyLog {
  mock: { calls: unknown[][]; invocationCallOrder: number[] };
}

/**
 * Keys touched by KV since {@link watchKvOps} was called, per operation.
 *
 * `writeTrail`: every `put` / `delete` / `list` in the order it actually ran,
 * as `"{op} {key}"` — e.g. `"put publicshelves:abc"` — where a `list` entry's
 * key is its `prefix` option (`""` when none was passed), e.g.
 * `"list tokenidx:{uid}:"`. Assert it with `toEqual` to pin a handler's
 * COMPLETE mutation sequence, order included. `list` is in the trail because a
 * revoke-all's correctness depends on it (#431): the index is listed BEFORE
 * the `token:` deletes, and before a following mint puts its own index.
 *
 * The sequence comes from Vitest's global `invocationCallOrder`, so it is one
 * real cross-spy ordering rather than four independent per-op lists. It
 * records when a call was ENTERED, not when its promise settled; a handler
 * that `await`s its writes one at a time — which every write ordering rule in
 * this codebase relies on — makes the two identical.
 *
 * Reads are deliberately excluded from the trail: an order rule about writes
 * must not break because auth middleware or a parallel `Promise.all` read
 * moved. Use {@link KvOpLog.getKeys} for read cost.
 */
export interface KvOpLog {
  getKeys: () => string[];
  putKeys: () => string[];
  deleteKeys: () => string[];
  /** The `prefix` option of every `list` call, in call order (`""` when absent). */
  listPrefixes: () => string[];
  /** Every `put` / `delete` / `list` in run order, as `"{op} {key}"`; reads
   *  excluded. Semantics: see {@link KvOpLog}. */
  writeTrail: () => string[];
}

/**
 * Record which KV keys a request touched, without changing KV behaviour.
 *
 * The spies call STRAIGHT THROUGH to the underlying namespace, so a mock built
 * by `createMockKV()` keeps enforcing its TTL floor while being watched — the
 * recorder observes, it never substitutes.
 *
 * Three things it is used for across the worker suites:
 * - READ COST: pinning the exact `get` keys a handler pays for, so an extra KV
 *   round-trip added to a hot path (e.g. the public read path) fails a test
 *   instead of quietly doubling the request's KV bill.
 * - SIDE-EFFECT FREEDOM: proving a read-only handler performed no `put` /
 *   `delete` at all, so an unauthenticated stranger can never pick a key to be
 *   written.
 * - WRITE ORDER (`writeTrail`): pinning the SEQUENCE of a multi-step mutation
 *   whose partial-failure safety depends on which step lands first. The three
 *   per-op lists cannot see that — a handler that swaps two writes keeps
 *   every one of them green. A `list` is part of the sequence, labelled by
 *   its `prefix` (see {@link KvOpLog}).
 *
 * Call it AFTER seeding, so only the request under test is counted, and restore
 * the spies in `afterEach` (`vi.restoreAllMocks()`); the recorder installs
 * `vi.spyOn` handlers and does not clean up after itself.
 *
 * Scope caveat for the write assertions: they pin the HANDLER only. A request
 * sent with `DEV_MODE` short-circuits the per-IP `rateLimit` middleware, so its
 * one counter `put` per request — the pipeline's only fixed write — is absent
 * by construction and is NOT what such an assertion proves.
 */
export function watchKvOps(kv: KVNamespace): KvOpLog {
  const gets = vi.spyOn(kv, "get");
  const puts = vi.spyOn(kv, "put");
  const deletes = vi.spyOn(kv, "delete");
  const lists = vi.spyOn(kv, "list");
  const keysOf = (spy: SpyLog): string[] =>
    spy.mock.calls.map((call) => String(call[0]));
  const prefixOf = (call: unknown[]): string =>
    String((call[0] as KVNamespaceListOptions | undefined)?.prefix ?? "");
  const trailOf = (labelled: [string, SpyLog][]): string[] =>
    labelled
      .flatMap(([op, spy]) =>
        spy.mock.calls.map((call, i) => ({
          at: spy.mock.invocationCallOrder[i],
          entry: `${op} ${op === "list" ? prefixOf(call) : String(call[0])}`,
        })),
      )
      .sort((a, b) => a.at - b.at)
      .map((op) => op.entry);
  return {
    getKeys: () => keysOf(gets),
    putKeys: () => keysOf(puts),
    deleteKeys: () => keysOf(deletes),
    listPrefixes: () => lists.mock.calls.map(prefixOf),
    writeTrail: () =>
      trailOf([
        ["put", puts],
        ["delete", deletes],
        ["list", lists],
      ]),
  };
}

/**
 * Make the FIRST `op` (`put` or `delete`) on `key` reject with `Error("KV down")`;
 * every other call, and any later `op` on `key`, goes straight through to `kv`. For
 * partial-failure cases whose retry must be allowed to write. Installs a `vi.spyOn`
 * on `kv[op]` like {@link watchKvOps} — restore it in `afterEach`
 * (`vi.restoreAllMocks()`), and call {@link watchKvOps} only AFTER this.
 */
export function failFirstWriteTo(
  kv: KVNamespace,
  op: "put" | "delete",
  key: string,
): void {
  const real = (kv[op] as (...args: unknown[]) => Promise<void>).bind(kv);
  let failed = false;
  vi.spyOn(kv, op).mockImplementation(((...args: unknown[]) => {
    if (args[0] === key && !failed) {
      failed = true;
      return Promise.reject(new Error("KV down"));
    }
    return real(...args);
  }) as never);
}
