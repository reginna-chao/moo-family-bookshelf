import { createMiddleware } from "hono/factory";
import type { Env } from "../index";
import { isPublicRoute } from "../utils/routes";

/** Standard rate limit: 60 req/min/IP */
const RATE_LIMIT_STANDARD = 60;

/** Strict rate limit for public routes: 10 req/min/IP */
const RATE_LIMIT_PUBLIC = 10;

const TTL_SECONDS = 120;

export const rateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";

    const minuteBucket = Math.floor(Date.now() / 60000);
    const isPublic = isPublicRoute(c.req.method, c.req.path);
    const prefix = isPublic ? "ratelimit:pub" : "ratelimit";
    const limit = isPublic ? RATE_LIMIT_PUBLIC : RATE_LIMIT_STANDARD;
    const key = `${prefix}:${ip}:${minuteBucket}`;

    const current = await c.env.KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      return c.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests" } },
        429,
      );
    }

    await c.env.KV.put(key, String(count + 1), {
      expirationTtl: TTL_SECONDS,
    });

    await next();
  },
);
