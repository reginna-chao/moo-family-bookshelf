/** Per-request KV op telemetry: a counting Proxy + ONE `kv_ops` line per /api/* request, registered ahead of
 *  `rateLimit` and `authMiddleware`. See docs/architecture.md → KV 操作數觀測（per-request kv_ops log）. */
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { Env } from "../utils/env";

/** Per-request KV operation tally, one field per Cloudflare billing class. */
export type KvOpCounts = { reads: number; writes: number; deletes: number };

/** KVNamespace method → counter; null = forwarded UNCOUNTED (only `list`, which nothing calls). A switch,
 *  not a lookup object: an object literal answers inherited keys ("toString") and would mis-count them. */
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
      // EVERY method, counted or not, runs on the ORIGINAL namespace: a real binding rejects the
      // proxy as `this` ("Illegal invocation"). Non-function properties pass through untouched.
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
 * (wrangler.toml:5-8, :70-72), so this ships as telemetry with nothing else to
 * configure, and the single object argument keeps its keys queryable as fields
 * in Workers Logs. Cost per request: one Proxy, one console.log, no KV
 * operation and no I/O — far below the free-tier allowance in wrangler.toml:5.
 *
 * Runs BEFORE `rateLimit` so whatever the rate-limit layers spend is counted
 * together with the handler's own operations. With the Rate Limiting bindings
 * configured they spend nothing: the per-IP tiers and the four per-minute
 * per-userId scopes resolve to a native binding through `bindingForWindow`
 * and cost no KV operation (the point of #160 item 1), leaving the auth-token
 * `get` as the entire fixed per-request cost; only the hourly scopes still
 * add a counter get+put. On a deployment whose wrangler.toml carries no
 * bindings the old per-IP and per-minute counters come back at 1 get + 1 put
 * each and surface in this line — which is exactly how that fallback is
 * meant to be noticed, alongside its `RATE_LIMIT_BINDING_MISSING` log.
 * DEV_MODE is not excluded either: the two `isDevMode(c.env)` short-circuits
 * in `middleware/rateLimit.ts` return before any binding or KV lookup, so a
 * dev line differs from production only on the hourly scopes (production pays
 * their get+put, dev does not) and on binding-less deployments — still
 * correct for what ran. No dev flag is logged: production never runs dev
 * mode.
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
          // Route PATTERN, never c.req.path (it carries :shareToken / userIds); routePath(c, -1) is
          // the matched handler's pattern, or "/api/*" when nothing matched (404).
          route: routePath(c, -1),
          // Unfinalized c.res is a fabricated placeholder (context.js:109-113); a handler Error is
          // already the onError 500 here, so only the non-Error throw above logs 0.
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
