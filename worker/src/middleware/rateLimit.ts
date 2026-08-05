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

/** Caller key used when no trusted client IP is available. */
export const UNKNOWN_CALLER_KEY = "unknown";

/**
 * Namespace for IPv6-ish input that could not be parsed. Keeps unparseable
 * values in their own key space so a crafted literal can never collide with a
 * real normalized `/64` bucket (which never starts with this prefix).
 */
export const RAW_CALLER_PREFIX = "raw:";

const HEXTET_COUNT = 8;
/** IPv6 caller keys are bucketed on the first 4 hextets (the /64 prefix). */
const PREFIX_HEXTETS = 4;

/** Parse a single IPv6 group ("1a2b") into a number, or null if malformed. */
function parseHextet(group: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
  return parseInt(group, 16);
}

/** Parse a dotted-quad ("1.2.3.4") into the two hextets it occupies. */
function parseDottedQuad(quad: string): number[] | null {
  const octets = quad.split(".");
  if (octets.length !== 4) return null;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255))
    return null;
  const n = octets.map(Number);
  return [(n[0] << 8) | n[1], (n[2] << 8) | n[3]];
}

/** Parse one side of a `::` split into hextets. Empty segment yields []. */
function parseHextetGroups(segment: string): number[] | null {
  if (segment === "") return [];
  const groups = segment.split(":");
  const hextets: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    // Only the final group may be an embedded IPv4 literal (e.g. ::ffff:1.2.3.4)
    if (i === groups.length - 1 && groups[i].includes(".")) {
      const quad = parseDottedQuad(groups[i]);
      if (!quad) return null;
      hextets.push(...quad);
      continue;
    }
    const hextet = parseHextet(groups[i]);
    if (hextet === null) return null;
    hextets.push(hextet);
  }
  return hextets;
}

/** Expand an IPv6 literal (incl. `::` compression) into 8 hextets, or null. */
function expandIpv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const head = parseHextetGroups(halves[0]);
  const tail = halves.length === 2 ? parseHextetGroups(halves[1]) : [];
  if (!head || !tail) return null;

  const missing = HEXTET_COUNT - head.length - tail.length;
  // Without "::" the literal must already be complete; with it, at least one
  // zero group must be compressed away.
  if (halves.length === 1) return missing === 0 ? head : null;
  if (missing < 1) return null;

  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Render hextets 6-7 of an IPv4-mapped address back as a dotted quad. */
function mappedIpv4(hextets: number[]): string {
  const [hi, lo] = [hextets[6], hextets[7]];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True for ::ffff:a.b.c.d (IPv4-mapped IPv6). */
function isIpv4Mapped(hextets: number[]): boolean {
  return hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
}

/**
 * Normalize a client IP into a stable caller key.
 *
 * - IPv4 (and the `unknown` fallback) pass through unchanged.
 * - IPv4-mapped IPv6 collapses to its embedded IPv4, so `::ffff:1.2.3.4` and
 *   `1.2.3.4` share one bucket.
 * - Any other IPv6 collapses to its /64 prefix, rendered `h:h:h:h::/64` with
 *   zero-padded lowercase hextets, so all abbreviations of one address agree.
 * - Unparseable input keeps its own value, `raw:`-prefixed, rather than being
 *   merged into a shared bucket.
 */
export function normalizeCallerIp(ip: string): string {
  if (!ip.includes(":")) return ip;

  const hextets = expandIpv6(ip);
  // Prefix keeps unparseable input out of the normalized bucket namespace, so a
  // crafted literal can never alias a real /64 bucket.
  if (!hextets) return `${RAW_CALLER_PREFIX}${ip}`;
  if (isIpv4Mapped(hextets)) return mappedIpv4(hextets);

  const prefix = hextets
    .slice(0, PREFIX_HEXTETS)
    .map((h) => h.toString(16).padStart(4, "0"))
    .join(":");
  return `${prefix}::/64`;
}

/**
 * Trusted caller identity for per-caller counters (rate limits, verification
 * failure accounting).
 *
 * Only trust cf-connecting-ip (set by Cloudflare edge, not spoofable).
 *
 * The address is normalized before use: IPv6 callers are bucketed by their /64
 * prefix, because a residential IPv6 subscriber holds at least a /64 and
 * privacy extensions let the client rotate its interface identifier at will —
 * keying on the full address would hand out a fresh verification-failure budget
 * on every request. /64 is the smallest block an ISP assigns to a single
 * subscriber site, so it is the narrowest key a client cannot rotate out of.
 *
 * Note: this deliberately also coarsens the per-IP `rateLimit` middleware's key
 * granularity for IPv6 callers — the same rotation bypass exists there, and
 * closing it is intended.
 */
export function getCallerIp(c: Context<{ Bindings: Env }>): string {
  const ip = c.req.header("cf-connecting-ip");
  return ip ? normalizeCallerIp(ip) : UNKNOWN_CALLER_KEY;
}

export const rateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    // Skip rate limiting in dev mode (local wrangler dev / E2E tests)
    if (isDevMode(c.env)) {
      await next();
      return;
    }

    const ip = getCallerIp(c);

    const now = Date.now();
    const minuteBucket = Math.floor(now / BUCKET_MS);
    const isSensitive = isSensitivePublicRoute(c.req.method, c.req.path);
    const isPublic = isPublicRoute(c.req.method, c.req.path);
    const prefix = isSensitive
      ? "ratelimit:sens"
      : isPublic
        ? "ratelimit:pub"
        : "ratelimit";
    const limit = isSensitive
      ? RATE_LIMIT_SENSITIVE
      : isPublic
        ? RATE_LIMIT_PUBLIC
        : RATE_LIMIT_STANDARD;
    const key = `${prefix}:${ip}:${minuteBucket}`;

    // Known limitation: KV get-then-put is not atomic. Concurrent requests may
    // exceed the limit by ~2x in a burst. Acceptable at current scale; for stricter
    // enforcement, consider Cloudflare Rate Limiting rules or Durable Objects.
    const current = await c.env.KV.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((minuteBucket + 1) * BUCKET_MS - now) / 1000),
      );
      return c.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            retryAfter,
          },
        },
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
    const retryAfter = Math.max(
      1,
      Math.ceil(((bucket + 1) * windowMs - now) / 1000),
    );
    return c.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryAfter,
        },
      },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  await c.env.KV.put(key, String(count + 1), {
    expirationTtl: opts.windowSec * 2,
  });

  return null;
}
