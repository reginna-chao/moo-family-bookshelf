import type { Context, TypedResponse } from "hono";
import { createMiddleware } from "hono/factory";
import { KV_MIN_TTL_SECONDS } from "../kv/schema";
import { type Env, isDevMode } from "../utils/env";
import { isPublicRoute, sensitiveBucketFor } from "../utils/routes";
import { jsonError, type ErrorBody } from "../utils/errors";

/** Standard rate limit: 60 req/min/IP */
const RATE_LIMIT_STANDARD = 60;

/** Strict rate limit for public routes: 10 req/min/IP */
const RATE_LIMIT_PUBLIC = 10;

/**
 * Extra-strict rate limit for sensitive public routes: 3 req/min/IP.
 *
 * One value, two counters — see {@link rateLimitBucketFor}.
 */
const RATE_LIMIT_SENSITIVE = 3;

const TTL_SECONDS = 120;
const BUCKET_MS = 60000;

/** KV key prefix of one per-IP counter. Full key: `{prefix}:{ip}:{bucket}`. */
const PREFIX_STANDARD = "ratelimit";
const PREFIX_PUBLIC = "ratelimit:pub";
const PREFIX_SENSITIVE_ONBOARDING = "ratelimit:sens";
const PREFIX_SENSITIVE_LOOKUP = "ratelimit:sens:lookup";

/** The per-IP counter a request is charged against. */
export interface RateLimitBucket {
  /** KV key prefix; the full key is `{prefix}:{ip}:{minuteBucket}`. */
  prefix: string;
  /** Requests allowed per caller per minute. */
  limit: number;
}

/**
 * Pick the counter (key prefix + limit) for a request.
 *
 * Path-only, because the middleware runs before body parsing. Three tiers:
 * standard, public, and sensitive — and the sensitive tier keeps TWO counters at
 * the SAME limit, one for family create / join and one for `/api/auth/lookup`,
 * so a verified account's onboarding (2 lookups + 1 create/join within a minute)
 * cannot exhaust its own budget and leave no room for a retry. See
 * {@link sensitiveBucketFor} for the split's rationale.
 *
 * The nested prefixes cannot alias each other: aliasing `ratelimit:sens:lookup:
 * {ip}:{bucket}` would need an onboarding caller key of exactly `lookup`, and
 * even then the two keys differ in shape — the onboarding key ends in a single
 * colon-free minute bucket where the lookup key still has `{ip}:{bucket}`. Same
 * argument for `ratelimit:pub` under `ratelimit`.
 */
export function rateLimitBucketFor(
  method: string,
  path: string,
): RateLimitBucket {
  const sensitive = sensitiveBucketFor(method, path);
  if (sensitive === "lookup") {
    return { prefix: PREFIX_SENSITIVE_LOOKUP, limit: RATE_LIMIT_SENSITIVE };
  }
  if (sensitive === "onboarding") {
    return {
      prefix: PREFIX_SENSITIVE_ONBOARDING,
      limit: RATE_LIMIT_SENSITIVE,
    };
  }
  if (isPublicRoute(method, path)) {
    return { prefix: PREFIX_PUBLIC, limit: RATE_LIMIT_PUBLIC };
  }
  return { prefix: PREFIX_STANDARD, limit: RATE_LIMIT_STANDARD };
}

/** Message used by every RATE_LIMITED response, per-IP and per-userId alike. */
export const RATE_LIMITED_MESSAGE = "Too many requests";

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
    const { prefix, limit } = rateLimitBucketFor(c.req.method, c.req.path);
    const key = `${prefix}:${ip}:${minuteBucket}`;

    // Known limitation, stated honestly: KV get-then-put is not atomic and
    // nothing serializes concurrent requests. Every request that reads before
    // the first write lands sees the same count and is admitted, so the
    // overshoot in a burst is bounded by the CALLER'S CONCURRENCY, not by any
    // fixed factor — an attacker firing N requests in parallel can have all N
    // admitted inside one bucket. The limit only bounds sequential traffic.
    // This property is shared by every KV-backed counter in this codebase: this
    // per-IP counter, the per-userId counters below, and the verification
    // attempt ceiling in `services/verification.ts` that reuses them. A hard
    // bound needs serialization the KV API cannot provide — Durable Objects or
    // Cloudflare's native rate-limiting binding. That is a separate decision,
    // deliberately not taken here.
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
            message: RATE_LIMITED_MESSAGE,
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

/** Options shared by the per-userId counter and its Hono wrapper. */
export interface PerUserRateLimitOptions {
  userId: string;
  /** Counter namespace, e.g. "verify" or "put-books". Keeps counters independent. */
  scope: string;
  max: number;
  /** Window length in seconds. MUST be > 0 — a non-positive window makes the
   *  bucket index (and `retryAfter`) degenerate in {@link peekPerUserRateLimit}. */
  windowSec: number;
}

/** Verdict of a per-userId counter check. `retryAfter` is in whole seconds. */
export type PerUserRateLimitVerdict =
  { limited: false } | { limited: true; retryAfter: number };

/**
 * One read of a per-userId counter: the verdict, plus everything needed to
 * charge the SAME window afterwards.
 *
 * Exists so a caller that only wants to charge SOME outcomes (the verification
 * gate charges wrong guesses only) still costs exactly one KV read and at most
 * one KV write per request — the count observed here is reused for the write
 * instead of being read again.
 */
export interface PerUserRateLimitReading {
  verdict: PerUserRateLimitVerdict;
  /** Counter key of the window that was read. */
  key: string;
  /** Count observed at read time. */
  count: number;
  /** Window length in seconds; determines the counter TTL on write (clamped up
   *  to the KV 60s floor in {@link chargePerUserRateLimit}). */
  windowSec: number;
}

/**
 * Read a per-userId counter WITHOUT charging it, KV-only (no Hono `Context`).
 *
 * This is the single implementation of the counter key/verdict derivation:
 * {@link consumePerUserRateLimit}, the `Context`-aware
 * {@link enforcePerUserRateLimit} wrapper, and the verification gate
 * (`validateVerification` in `services/verification.ts`) all go through it, so
 * none of them can drift apart. Pure read — pair it with
 * {@link chargePerUserRateLimit} to actually consume a slot.
 *
 * Does NOT consult DEV_MODE — that gating belongs to the callers, which own the
 * `Env`.
 */
export async function peekPerUserRateLimit(
  kv: KVNamespace,
  opts: PerUserRateLimitOptions,
): Promise<PerUserRateLimitReading> {
  const windowMs = opts.windowSec * 1000;
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const key = `ratelimit:user:${opts.scope}:${opts.userId}:${bucket}`;

  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;
  const windowSec = opts.windowSec;

  if (count >= opts.max) {
    const retryAfter = Math.max(
      1,
      Math.ceil(((bucket + 1) * windowMs - now) / 1000),
    );
    return { verdict: { limited: true, retryAfter }, key, count, windowSec };
  }

  return { verdict: { limited: false }, key, count, windowSec };
}

/**
 * Charge one slot against the window described by `reading`.
 *
 * Side effect: writes `ratelimit:user:{scope}:{userId}:{bucket}` (TTL = 2
 * windows, clamped up to the KV 60s floor). Call it only for a reading whose
 * verdict was `limited: false` — a rejected request must not extend the window.
 *
 * The clamp is defensive: every caller today passes `windowSec >= 60`, but a
 * future window under 30s would derive a TTL real KV rejects, turning an
 * admitted request into a 500 — and inside `chargeWrongGuess`'s `Promise.all`
 * (`services/verification.ts`) that throw would silently stop the verification
 * attempt ceiling from counting.
 *
 * Known limitation: KV get-then-put is not atomic, and the read happened in
 * {@link peekPerUserRateLimit}. Requests fired in parallel all observe the same
 * pre-write count, so a burst can exceed `max` by as much as the caller's own
 * concurrency — there is no fixed overshoot factor. Identical caveat to the
 * per-IP `rateLimit` middleware above; a hard bound would require Durable
 * Objects or Cloudflare's native rate-limiting binding.
 */
export async function chargePerUserRateLimit(
  kv: KVNamespace,
  reading: PerUserRateLimitReading,
): Promise<void> {
  await kv.put(reading.key, String(reading.count + 1), {
    expirationTtl: Math.max(KV_MIN_TTL_SECONDS, reading.windowSec * 2),
  });
}

/**
 * Count one request against a per-userId ceiling: peek, then charge when the
 * request is admitted. A rejected request does not extend the window.
 *
 * The single-shot form used by every caller that charges EVERY request (the
 * user / borrow / bookshelf / public-shelf / verify-write / family-write
 * limits via {@link enforcePerUserRateLimit}). Callers that charge only some outcomes use
 * {@link peekPerUserRateLimit} + {@link chargePerUserRateLimit} directly.
 */
export async function consumePerUserRateLimit(
  kv: KVNamespace,
  opts: PerUserRateLimitOptions,
): Promise<PerUserRateLimitVerdict> {
  const reading = await peekPerUserRateLimit(kv, opts);
  if (reading.verdict.limited) return reading.verdict;

  await chargePerUserRateLimit(kv, reading);
  return reading.verdict;
}

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
 * Counting lives in {@link consumePerUserRateLimit}; this wrapper only adds the
 * DEV_MODE bypass and the HTTP rendering.
 */
export async function enforcePerUserRateLimit(
  c: Context<{ Bindings: Env }>,
  opts: PerUserRateLimitOptions,
): Promise<(Response & TypedResponse<ErrorBody, 429, "json">) | null> {
  if (isDevMode(c.env)) return null;

  const verdict = await consumePerUserRateLimit(c.env.KV, opts);
  if (!verdict.limited) return null;

  return jsonError(c, 429, "RATE_LIMITED", RATE_LIMITED_MESSAGE, {
    retryAfter: verdict.retryAfter,
  });
}
