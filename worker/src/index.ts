import { Hono } from "hono";
import { cors } from "hono/cors";
import { rateLimit } from "./middleware/rateLimit";
import { authMiddleware } from "./middleware/auth";
import { userRoutes } from "./routes/user";
import { familyRoutes } from "./routes/family";
import { bookshelfRoutes } from "./routes/bookshelf";

export interface Env {
  KV: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// CORS for Extension and PWA
app.use("*", cors());

// Rate limiting for API routes
app.use("/api/*", rateLimit);

// Auth middleware (optional Bearer token)
app.use("/api/*", authMiddleware);

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "moo-family-bookshelf" }));

// Routes
app.route("/api/user", userRoutes);
app.route("/api/family", familyRoutes);
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
