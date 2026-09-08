/**
 * Per-request KV operation telemetry: a counting Proxy around the KV binding,
 * plus ONE `kv_ops` log line per /api/* request. Registered in index.ts on
 * `/api/*` ahead of `rateLimit` and `authMiddleware`, so their KV operations
 * are counted together with the handler's own.
 */
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { Env } from "../utils/env";

/** Per-request KV operation tally, one field per Cloudflare billing class. */
export type KvOpCounts = { reads: number; writes: number; deletes: number };

/**
 * Maps a KVNamespace method to its counter, null for anything else. A null
 * kind means the method is still forwarded, just UNCOUNTED — `list` is the
 * only such method today and nothing calls it; giving it a tally is one extra
 * case here plus a field on KvOpCounts. A switch, not a lookup object: an
 * object literal answers inherited keys ("toString") too and would mis-count a
 * property read as an operation.
 */
function kvOpKindFor(prop: string | symbol): keyof KvOpCounts | null {
  switch (prop) {
    case "get":
    case "getWithMetadata":
      return "reads";
    case "put":
      return "writes";
    case "delete":
      return "deletes";
    default:
      return null;
  }
}

/**
 * Pure-forwarding KV wrapper that tallies operations into `counts`: it adds,
 * reorders, caches and dedupes nothing. Non-function properties come back from
 * `Reflect.get` untouched; every method, counted or not, is applied to the
 * ORIGINAL namespace, never the proxy — a real KV binding is a host object that
 * checks its receiver (hence the `get` trap omitting `receiver`). Counting
 * precedes forwarding: Cloudflare bills an attempted operation even if it then
 * rejects.
 */
export function createCountingKv(
  kv: KVNamespace,
  counts: KvOpCounts,
): KVNamespace {
  return new Proxy(kv, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      // EVERY method is re-applied to the ORIGINAL namespace, counted or not:
      // a real KV binding is a host object that rejects the proxy as `this`
      // ("Illegal invocation"), so handing back a bare function breaks the
      // UNCOUNTED methods too (`list` today). Non-function properties pass
      // through untouched.
      if (typeof value !== "function") return value;
      const kind = kvOpKindFor(prop);
      return (...args: unknown[]): unknown => {
        if (kind !== null) counts[kind] += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/**
 * ONE structured log line per /api/* request carrying its KV operation count —
 * the #160 read amplification was only spotted by chance on the dashboard,
 * months late. `[observability]` is already on at `head_sampling_rate = 1`
 * (wrangler.toml:5-8, :23-25), so this ships as telemetry with nothing else to
 * configure, and the single object argument keeps its keys queryable as fields
 * in Workers Logs. Cost per request: one Proxy, one console.log, no KV
 * operation and no I/O — far below the free-tier allowance in wrangler.toml:5.
 *
 * Runs BEFORE `rateLimit` so the fixed per-request cost (per-IP counter
 * get+put, auth token get, `enforcePerUserRateLimit` get+put) is counted with
 * the handler's own operations — that fixed cost is what must become visible.
 * DEV_MODE is not excluded: there `rateLimit` (middleware/rateLimit.ts:208) and
 * `enforcePerUserRateLimit` (:407) short-circuit, so a dev line carries one
 * fewer get+put per counter than production for the same route — still correct
 * for what ran. No dev flag is logged: production never runs dev mode.
 *
 * The proxy replaces `c.env` rather than mutating `c.env.KV`, since the runtime
 * `env` is shared by every request in the isolate. Assignment is safe and
 * request-scoped: `env` is a plain public Context field (context.js:28,66) and
 * `app.route()` sub-apps share the one Context, so all readers see the proxy.
 *
 * Accepted residuals (log volume is 1:1 with request volume; the line makes
 * cost visible, it does not make anyone look) and the post-deploy observation
 * pass are documented in docs/architecture.md → 「KV 操作數觀測」 and tracked
 * on issue #163.
 */
export const withKvOpCounting = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const counts: KvOpCounts = { reads: 0, writes: 0, deletes: 0 };
    c.env = { ...c.env, KV: createCountingKv(c.env.KV, counts) };

    try {
      await next();
    } finally {
      // `finally`, not a post-await line: hono routes only `Error` throws to
      // app.onError (compose.js:23-31), so a non-Error throw escapes next().
      try {
        console.log({
          event: "kv_ops",
          method: c.req.method,
          // Route PATTERN, never c.req.path: the raw path carries secrets and
          // identifiers (:shareToken IS the public shelf's secret; :id is an
          // email-derived userId). routePath(c, -1) is the last matched route —
          // the handler's pattern, or "/api/*" when nothing matched (404).
          route: routePath(c, -1),
          // c.finalized reports whether a response exists; reading c.res
          // without it fabricates an empty placeholder (context.js:109-113). A
          // handler's Error is already the onError 500 here; only the
          // non-Error throw above reaches this with no response, logging 0.
          status: c.finalized ? c.res.status : 0,
          reads: counts.reads,
          writes: counts.writes,
          deletes: counts.deletes,
        });
      } catch {
        // Telemetry must never fail a request; console.error could throw too.
      }
    }
  },
);
