import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { rateLimit } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { userRoutes } from "./routes/user";
import { familyRoutes } from "./routes/family";
import { bookshelfRoutes } from "./routes/bookshelf";
import { borrowRoutes } from "./routes/borrow";
import { authRoutes } from "./routes/auth";
import { verifyRoutes } from "./routes/verify";
import { publicShelfRoutes, publicQueryRoutes } from "./routes/publicShelf";
import { jsonError } from "./utils/errors";
import { isDevMode, type Env } from "./utils/env";

export type { Env } from "./utils/env";
export { isDevMode } from "./utils/env";

/** Max request body size: 256KB */
const MAX_BODY_SIZE = 262144;

/** Check if the origin is allowed for CORS */
export function isAllowedOrigin(origin: string, devMode?: boolean): boolean {
  // Readmoo domains — the content script runs on both bookshelf sites:
  //   read.readmoo.com = legacy bookshelf, next.readmoo.com = new bookshelf.
  // Both are listed explicitly so the intent is testable; the subdomain regex
  // below stays as the catch-all for any other readmoo subdomain.
  if (origin === "https://readmoo.com") return true;
  if (origin === "https://read.readmoo.com") return true;
  if (origin === "https://next.readmoo.com") return true;
  if (/^https:\/\/[a-zA-Z0-9-]+\.readmoo\.com$/.test(origin)) return true;

  // PWA on Cloudflare Pages (production + preview deploys)
  if (origin === "https://moo-family-bookshelf.pages.dev") return true;
  if (/^https:\/\/[a-z0-9]+\.moo-family-bookshelf\.pages\.dev$/.test(origin))
    return true;

  // PWA on Cloudflare Pages (dev + preview deploys)
  if (origin === "https://moo-family-bookshelf-dev.pages.dev") return true;
  if (
    /^https:\/\/[a-z0-9]+\.moo-family-bookshelf-dev\.pages\.dev$/.test(origin)
  )
    return true;

  // localhost (any port, http or https, dev only — gated behind DEV_MODE binding)
  if (devMode && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;

  // RFC 1918 private IPs (dev only — for LAN testing, e.g. PWA on mobile)
  // 10.x.x.x, 172.16.x.x–172.31.x.x, 192.168.x.x
  if (
    devMode &&
    /^https?:\/\/(10(\.\d{1,3}){3}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|192\.168(\.\d{1,3}){2})(:\d+)?$/.test(
      origin,
    )
  )
    return true;

  // Chrome Extension
  if (/^chrome-extension:\/\/[a-z]{32}$/.test(origin)) return true;

  return false;
}

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
 * Accepted residual — log volume is bounded by request volume, not by the
 * limiter: running ahead of `rateLimit` means a request rejected with 429 still
 * emits its line, and the per-IP ceiling throttles responses, not log events.
 * At `head_sampling_rate = 1` every request is one event, so an unauthenticated
 * flood of any /api/* path fills the log 1:1 with junk lines. On the free plan
 * the Worker's own request cap (~100k req/day, .claude/rules/global.md) trips
 * before the log allowance (200k events/day, wrangler.toml:5), so the cost is
 * a day's allowance half-spent on noise, with any `console.error` line that
 * matters — including the kicked-tombstone fail-open alert
 * (routes/family.ts:1361) — buried in it; on a paid plan it is a log bill.
 * Detection degrades; no data disclosure, no auth bypass, no user-facing
 * availability change. The order is deliberately NOT reversed, for the reason
 * above: a lower sampling rate would thin every route's sample, and skipping
 * 429 lines bounds one IP.
 *
 * This line makes per-route KV cost VISIBLE; it does not make anyone LOOK.
 * Cloudflare's default telemetry cannot substitute for it — KV analytics are
 * per-namespace per-day with no route or request dimension, Workers Metrics
 * aggregate the whole Worker, and the invocation log carries no KV counts —
 * but Workers Logs offers no alerting on custom fields on this tier either,
 * so consumption stays pull-based. The follow-up is a post-deploy observation
 * pass (walk every route once, capture with `wrangler tail --format=json` or
 * the dashboard, compare each route's reads/writes against the exact budgets
 * pinned in tests/integration/budget/, record the production baseline), tracked
 * on issue #163; whether to add an over-budget event is decided after that
 * baseline exists, not before.
 */
const withKvOpCounting = createMiddleware<{ Bindings: Env }>(
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

const app = new OpenAPIHono<{ Bindings: Env }>();

// Security headers on ALL responses
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  c.res.headers.set("X-XSS-Protection", "0");
});

// CORS with dynamic origin validation
app.use("*", async (c, next) => {
  const devMode = isDevMode(c.env);
  const middleware = cors({
    origin: (origin) => (isAllowedOrigin(origin, devMode) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });
  return middleware(c, next);
});

// Request body size limit for API routes
app.use("/api/*", async (c, next) => {
  const contentLength = c.req.header("Content-Length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > MAX_BODY_SIZE) {
      return jsonError(
        c,
        413,
        "PAYLOAD_TOO_LARGE",
        "Request body exceeds 256KB limit",
      );
    }
  } else if (c.req.method !== "GET" && c.req.method !== "DELETE") {
    // No Content-Length: read body to verify size.
    // Cloudflare edge enforces its own body limit (~100MB) as a backstop.
    const buf = await c.req.raw.clone().arrayBuffer();
    if (buf.byteLength > MAX_BODY_SIZE) {
      return jsonError(
        c,
        413,
        "PAYLOAD_TOO_LARGE",
        "Request body exceeds 256KB limit",
      );
    }
  }
  await next();
});

// Per-request KV operation logging (see withKvOpCounting above) — must stay
// ahead of rateLimit and authMiddleware so their KV operations are counted too.
app.use("/api/*", withKvOpCounting);

// Rate limiting for API routes
app.use("/api/*", rateLimit);

// Auth middleware (optional Bearer token)
app.use("/api/*", authMiddleware);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "moo-family-bookshelf" }));

/**
 * API version endpoint for client compatibility checks.
 * Bump API_VERSION when making breaking API changes.
 *
 * 2 — the verification gate on the public identity endpoints (`POST /api/family`,
 * `POST /api/family/:id/join`, `POST /api/auth/lookup`). Counts as an
 * authentication-mechanism change per docs/architecture.md → 何時遞增
 * API_VERSION: for an account with PWA verification configured, a client that
 * sends no `verifySecret` now gets 403 on create and a `requiresVerification: 1`
 * answer with no membership data on lookup.
 *
 * Note the signal direction: `/api/version` only lets a client detect a server
 * that is TOO OLD (server `apiVersion` < the client's `MIN_API_VERSION`). It
 * cannot warn an outdated client talking to this Worker — that degradation is
 * covered in the CHANGELOG ("請更新擴充功能"). Raising `MIN_API_VERSION` to 2 in
 * the Extension/PWA `VersionWarning.tsx` is the follow-up that makes a stale
 * self-hosted Worker (still missing the gate) visible to its users.
 */
const API_VERSION = 2;
const SERVER_VERSION = "0.1.0";

app.get("/api/version", (c) =>
  c.json({ data: { apiVersion: API_VERSION, serverVersion: SERVER_VERSION } }),
);

// Dev-only: OpenAPI spec + Swagger UI
app.get("/api/_openapi.json", (c) => {
  if (!isDevMode(c.env)) {
    return jsonError(c, 404, "NOT_FOUND", "Route not found");
  }
  const spec = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "MooFamily Bookshelf API", version: SERVER_VERSION },
  });
  return c.json(spec);
});

app.get("/api/_docs", async (c) => {
  if (!isDevMode(c.env)) {
    return jsonError(c, 404, "NOT_FOUND", "Route not found");
  }
  const handler = swaggerUI({ url: "/api/_openapi.json" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return handler(c as any, async () => {}) as unknown as Response;
});

// Routes
app.route("/api/user", userRoutes);
app.route("/api/user", verifyRoutes);
app.route("/api/user", publicShelfRoutes);
app.route("/api/family", familyRoutes);
app.route("/api/auth", authRoutes);
app.route("/api", bookshelfRoutes);
app.route("/api", borrowRoutes);
app.route("/api", publicQueryRoutes);

// 404 fallback
app.notFound((c) => jsonError(c, 404, "NOT_FOUND", "Route not found"));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return jsonError(c, 500, "INTERNAL_ERROR", "Internal server error");
});

export default app;
