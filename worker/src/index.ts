import { Hono } from "hono";
import { cors } from "hono/cors";
import { userRoutes } from "./routes/user";
import { familyRoutes } from "./routes/family";
import { bookshelfRoutes } from "./routes/bookshelf";

export interface Env {
  KV: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// CORS for Extension and PWA
app.use("*", cors());

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
