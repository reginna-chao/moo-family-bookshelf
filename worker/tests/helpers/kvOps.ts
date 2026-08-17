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
 *   per-op lists above cannot see that — a handler that swaps two writes keeps
 *   every one of them green.
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
import { vi } from "vitest";

/** The spy surface this helper reads — structural, so all three ops share it. */
interface SpyLog {
  mock: { calls: unknown[][]; invocationCallOrder: number[] };
}

/** Keys touched by KV since {@link watchKvOps} was called, per operation. */
export interface KvOpLog {
  getKeys: () => string[];
  putKeys: () => string[];
  deleteKeys: () => string[];
  /**
   * Every `put` / `delete` in the order it actually ran, as `"{op} {key}"` —
   * e.g. `"put publicshelves:abc"`. Assert it with `toEqual` to pin a handler's
   * COMPLETE mutation sequence, order included.
   *
   * The sequence comes from Vitest's global `invocationCallOrder`, so it is one
   * real cross-spy ordering rather than three independent per-op lists. It
   * records when a call was ENTERED, not when its promise settled; a handler
   * that `await`s its writes one at a time — which every write ordering rule in
   * this codebase relies on — makes the two identical.
   *
   * Reads are deliberately excluded: an order rule about writes must not break
   * because auth middleware or a parallel `Promise.all` read moved. Use
   * {@link KvOpLog.getKeys} for read cost.
   */
  writeTrail: () => string[];
}

export function watchKvOps(kv: KVNamespace): KvOpLog {
  const gets = vi.spyOn(kv, "get");
  const puts = vi.spyOn(kv, "put");
  const deletes = vi.spyOn(kv, "delete");
  const keysOf = (spy: SpyLog): string[] =>
    spy.mock.calls.map((call) => String(call[0]));
  const trailOf = (labelled: [string, SpyLog][]): string[] =>
    labelled
      .flatMap(([op, spy]) =>
        spy.mock.calls.map((call, i) => ({
          at: spy.mock.invocationCallOrder[i],
          entry: `${op} ${String(call[0])}`,
        })),
      )
      .sort((a, b) => a.at - b.at)
      .map((op) => op.entry);
  return {
    getKeys: () => keysOf(gets),
    putKeys: () => keysOf(puts),
    deleteKeys: () => keysOf(deletes),
    writeTrail: () =>
      trailOf([
        ["put", puts],
        ["delete", deletes],
      ]),
  };
}
