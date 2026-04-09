import { Hono } from "hono";
import { cors } from "hono/cors";
import { rateLimit } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { userRoutes } from "./routes/user";
import { familyRoutes } from "./routes/family";
import { bookshelfRoutes } from "./routes/bookshelf";
import { authRoutes } from "./routes/auth";
import { verifyRoutes } from "./routes/verify";
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

const app = new Hono<{ Bindings: Env }>();

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
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds 256KB limit",
          },
        },
        413,
      );
    }
  } else if (c.req.method !== "GET" && c.req.method !== "DELETE") {
    // No Content-Length: read body to verify size.
    // Cloudflare edge enforces its own body limit (~100MB) as a backstop.
    const buf = await c.req.raw.clone().arrayBuffer();
    if (buf.byteLength > MAX_BODY_SIZE) {
      return c.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds 256KB limit",
          },
        },
        413,
      );
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

// Routes
app.route("/api/user", userRoutes);
app.route("/api/user", verifyRoutes);
app.route("/api/family", familyRoutes);
app.route("/api/auth", authRoutes);
app.route("/api", bookshelfRoutes);

// 404 fallback
app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404),
);

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    500,
  );
});

export default app;
