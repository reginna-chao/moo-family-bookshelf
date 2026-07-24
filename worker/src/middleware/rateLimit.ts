import type { Context, TypedResponse } from "hono";
import { createMiddleware } from "hono/factory";
import { type Env, isDevMode } from "../utils/env";
import { isPublicRoute, isSensitivePublicRoute } from "../utils/routes";
import type { ErrorBody } from "../utils/errors";

/** Standard rate limit: 60 req/min/IP */
const RATE_LIMIT_STANDARD = 60;

/** Strict rate limit for public routes: 10 req/min/IP */
const RATE_LIMIT_PUBLIC = 10;

/** Extra-strict rate limit for sensitive public routes (create/join family): 3 req/min/IP */
const RATE_LIMIT_SENSITIVE = 3;

const TTL_SECONDS = 120;
const BUCKET_MS = 60000;

export const rateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    // Skip rate limiting in dev mode (local wrangler dev / E2E tests)
    if (isDevMode(c.env)) {
      await next();
      return;
    }

    // Only trust cf-connecting-ip (set by Cloudflare edge, not spoofable)
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";

    const now = Date.now();
    const minuteBucket = Math.floor(now / BUCKET_MS);
    const isSensitive = isSensitivePublicRoute(c.req.method, c.req.path);
    const isPublic = isPublicRoute(c.req.method, c.req.path);
    const prefix = isSensitive ? "ratelimit:sens" : isPublic ? "ratelimit:pub" : "ratelimit";
    const limit = isSensitive ? RATE_LIMIT_SENSITIVE : isPublic ? RATE_LIMIT_PUBLIC : RATE_LIMIT_STANDARD;
    const key = `${prefix}:${ip}:${minuteBucket}`;

    // Known limitation: KV get-then-put is not atomic. Concurrent requests may
    // exceed the limit by ~2x in a burst. Acceptable at current scale; for stricter
    // enforcement, consider Cloudflare Rate Limiting rules or Durable Objects.
    const current = await c.env.KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      const retryAfter = Math.max(1, Math.ceil(((minuteBucket + 1) * BUCKET_MS - now) / 1000));
      return c.json(
        { error: { code: "RATE_LIMITED", message: "Too many requests", retryAfter } },
        429,
        {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
        },
      );
    }

    await c.env.KV.put(key, String(count + 1), {
      expirationTtl: TTL_SECONDS,
    });

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(limit - count - 1));

    await next();
  },
);

/**
 * Per-userId rate limit helper (distinct from the per-IP `rateLimit` middleware).
 *
 * Enforces a configurable ceiling on requests tied to an identifier (typically
 * the authenticated userId) to prevent single-account abuse across rotating IPs.
 * Returns a typed 429 JSON response when the limit is exceeded, otherwise
 * increments the counter and returns `null` to let the handler proceed. The
 * return type is the concrete `TypedResponse<..., 429, "json">` produced by
 * `c.json(...)`, so callers can `return` it directly without a cast — the
 * status literal lets it satisfy an OpenAPIHono handler's declared 429 response.
 *
 * KV key format: `ratelimit:user:{scope}:{userId}:{bucket}` where
 * `bucket = floor(Date.now() / windowMs)`.
 *
 * Known limitation: KV get-then-put is not atomic. Concurrent bursts may exceed
 * `max` by ~2x. Acceptable at current scale — identical caveat to the per-IP
 * `rateLimit` middleware. For strict enforcement, use Durable Objects.
 */
export async function enforcePerUserRateLimit(
  c: Context<{ Bindings: Env }>,
  opts: { userId: string; scope: string; max: number; windowSec: number },
): Promise<(Response & TypedResponse<ErrorBody, 429, "json">) | null> {
  if (isDevMode(c.env)) return null;

  const windowMs = opts.windowSec * 1000;
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const key = `ratelimit:user:${opts.scope}:${opts.userId}:${bucket}`;

  const current = await c.env.KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= opts.max) {
    const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
    return c.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests", retryAfter } },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  await c.env.KV.put(key, String(count + 1), {
    expirationTtl: opts.windowSec * 2,
  });

  return null;
}
