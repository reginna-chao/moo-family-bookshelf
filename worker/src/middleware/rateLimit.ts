import { createMiddleware } from "hono/factory";
import type { Env } from "../index";

const RATE_LIMIT = 60;
const WINDOW_SECONDS = 60;
const TTL_SECONDS = 120;

export const rateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const ip =
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for") ??
      "unknown";

    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${ip}:${minuteBucket}`;

    const current = await c.env.KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= RATE_LIMIT) {
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
