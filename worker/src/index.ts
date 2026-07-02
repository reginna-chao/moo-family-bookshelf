import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
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
  // Readmoo domains (exact + subdomains)
  if (origin === "https://readmoo.com") return true;
  if (origin === "https://read.readmoo.com") return true;
  if (/^https:\/\/[a-zA-Z0-9-]+\.readmoo\.com$/.test(origin)) return true;

  // PWA on Cloudflare Pages (production + preview deploys)
  if (origin === "https://moo-family-bookshelf.pages.dev") return true;
  if (/^https:\/\/[a-z0-9]+\.moo-family-bookshelf\.pages\.dev$/.test(origin)) return true;

  // PWA on Cloudflare Pages (dev + preview deploys)
  if (origin === "https://moo-family-bookshelf-dev.pages.dev") return true;
  if (/^https:\/\/[a-z0-9]+\.moo-family-bookshelf-dev\.pages\.dev$/.test(origin)) return true;

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
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 256KB limit");
    }
  } else if (c.req.method !== "GET" && c.req.method !== "DELETE") {
    // No Content-Length: read body to verify size.
    // Cloudflare edge enforces its own body limit (~100MB) as a backstop.
    const buf = await c.req.raw.clone().arrayBuffer();
    if (buf.byteLength > MAX_BODY_SIZE) {
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 256KB limit");
    }
  }
  await next();
});

// Rate limiting for API routes
app.use("/api/*", rateLimit);

// Auth middleware (optional Bearer token)
app.use("/api/*", authMiddleware);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "moo-family-bookshelf" }));

/**
 * API version endpoint for client compatibility checks.
 * Bump API_VERSION when making breaking API changes.
 */
const API_VERSION = 1;
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
