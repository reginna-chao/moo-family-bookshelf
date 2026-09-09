import type { Context, TypedResponse } from "hono";
import { createMiddleware } from "hono/factory";
import { KV_MIN_TTL_SECONDS } from "../kv/schema";
import { type Env, type RateLimitBindingName, isDevMode } from "../utils/env";
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
 * The nested prefixes cannot alias each other, on the binding path
 * (`{prefix}:{ip}`) and on the KV fallback (`{prefix}:{ip}:{bucket}`) alike.
 * The only variable part is the caller key, and {@link normalizeCallerIp} has a
 * CLOSED value range: a colon-free passthrough (an IPv4 literal, or
 * {@link UNKNOWN_CALLER_KEY}), a dotted quad, `hhhh:hhhh:hhhh:hhhh::/64`, or a
 * {@link RAW_CALLER_PREFIX}-prefixed literal. None of those is empty and none
 * begins with `sens:`, `lookup:` or `pub:`, so no caller key can carry a
 * shorter prefix's key into a longer prefix's space, nor stand in for the extra
 * non-empty segment the longer prefix always appends. The same closed range is
 * what keeps these keys clear of the per-userId ones — see
 * {@link BINDING_BY_LIMIT}.
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

/**
 * Period (seconds) every native Rate Limiting binding is configured with.
 *
 * The platform accepts only 10 or 60; all limits in this codebase are per
 * minute, so 60 is the single value used. Counters on longer windows (the
 * hourly per-userId scopes) have no binding and stay on KV.
 */
const BINDING_PERIOD_SECONDS = 60;

/**
 * Requests-per-minute -> binding name. ONE table: never resolve a binding by
 * name anywhere else.
 *
 * A binding is shared by every counter carrying the same limit (e.g. the per-IP
 * standard tier and the per-userId `borrow-list` scope both sit at 60/min);
 * isolation comes from the KEY passed to `limit()`, which keeps the same prefix
 * shape the KV counters used. Per-IP keys are `{tierPrefix}:{ip}` and per-userId
 * keys are `ratelimit:user:{scope}:{userId}`, so the two spaces cannot alias:
 * no value {@link normalizeCallerIp} can return begins with `user:` — its full
 * range is enumerated in {@link rateLimitBucketFor}.
 *
 * A Map, not an object literal: `Map.get` is typed `| undefined`, so an
 * unmapped limit cannot be read as a binding name under this tsconfig (no
 * `noUncheckedIndexedAccess`).
 *
 * Keys are written as literals, deliberately, even where a named constant
 * exists (`RATE_LIMIT_STANDARD` and friends): the binding NAME already encodes
 * its configured limit, so a key/name mismatch is visible on one line. Raising
 * a tier's limit without adding the matching binding leaves that limit unmapped
 * here; the request then falls through to the KV counter — never to the
 * binding's old number — and {@link warnMissingRateLimitBinding} reports it as
 * loudly as a binding missing from `env`, naming it `<unmapped:{max}/min>`.
 * Adding or changing any per-minute limit therefore means editing this table
 * and `wrangler.toml` in the same change.
 */
const BINDING_BY_LIMIT: ReadonlyMap<number, RateLimitBindingName> = new Map([
  // 60/min — per-IP standard tier, per-userId `borrow-list`
  [60, "RATE_LIMIT_60_PER_MIN"],
  // 30/min — per-userId `bookshelf`, `borrow-update`
  [30, "RATE_LIMIT_30_PER_MIN"],
  // 10/min — per-IP public tier, per-userId `borrow-create`
  [10, "RATE_LIMIT_10_PER_MIN"],
  // 3/min — per-IP sensitive tier, BOTH buckets (onboarding + lookup)
  [3, "RATE_LIMIT_3_PER_MIN"],
] as const);

/** Binding name configured for (max, window), or null when there is none. */
function bindingNameForWindow(
  max: number,
  windowSec: number,
): RateLimitBindingName | null {
  if (windowSec !== BINDING_PERIOD_SECONDS) return null;
  return BINDING_BY_LIMIT.get(max) ?? null;
}

/**
 * The native Rate Limiting binding serving (max, window), or null.
 *
 * Null means "count this one in KV instead", for three distinct reasons — see
 * {@link warnMissingRateLimitBinding} for which of them is logged:
 *
 * 1. the window is not {@link BINDING_PERIOD_SECONDS}, i.e. every hourly scope
 *    — no binding exists for those by design;
 * 2. {@link BINDING_BY_LIMIT} names a binding for this per-minute limit, but
 *    the deployment does not carry it — a self-hoster whose wrangler.toml
 *    predates the rate limiting bindings;
 * 3. the limit is per-minute but absent from {@link BINDING_BY_LIMIT}, i.e. a
 *    tier's number was changed without adding its binding.
 *
 * Never throws: a missing binding must degrade to the KV counter, not 500 the
 * request.
 */
export function bindingForWindow(
  env: Env,
  max: number,
  windowSec: number,
): RateLimit | null {
  const name = bindingNameForWindow(max, windowSec);
  if (!name) return null;
  return env[name] ?? null;
}

/**
 * Report a per-minute limit that reached the KV counter instead of a binding.
 *
 * Loud for EVERY 60s window, whichever way {@link bindingForWindow} came back
 * null: a binding {@link BINDING_BY_LIMIT} names but `env` does not carry
 * (reason 2 there, logged under its name), or a per-minute limit that table
 * does not name at all (reason 3, logged as `<unmapped:{max}/min>`). Silent
 * only for reason 1, the hourly scopes — those are KV counters by design, and
 * logging them would drown the signal this line exists for: "this deployment is
 * not counting per-minute traffic on the platform".
 *
 * One line per rate-limit CHECK, not per request: a route guarded by both the
 * per-IP middleware and a per-minute per-userId ceiling (`bookshelf`,
 * `borrow-create`, `borrow-list`, `borrow-update`) emits TWO lines per request
 * on a binding-less deployment.
 */
function warnMissingRateLimitBinding(max: number, windowSec: number): void {
  // Hourly scopes are KV by design — stay silent. A 60s window with no entry in
  // BINDING_BY_LIMIT is NOT by design: someone changed a limit without adding
  // the binding, and it must be as loud as a binding missing from the env.
  if (windowSec !== BINDING_PERIOD_SECONDS) return;
  const name = bindingNameForWindow(max, windowSec);
  console.error("RATE_LIMIT_BINDING_MISSING", {
    binding: name ?? `<unmapped:${max}/min>`,
  });
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

/** Verdict of one charge against the KV-backed per-IP counter. */
type IpCounterVerdict =
  { limited: false; remaining: number } | { limited: true; retryAfter: number };

/**
 * Charge one request against the KV per-IP counter `{prefix}:{ip}:{bucket}`.
 *
 * The FALLBACK path: reached only when the deployment carries no native
 * binding for this tier's limit. Side effect on the admitted branch — one
 * `put` with a 2-minute TTL; a rejected request does not extend the window.
 *
 * Known limitation of this path (and of every KV counter that remains: the
 * hourly per-userId scopes and the verification attempt ceiling in
 * `services/verification.ts`): get-then-put is not atomic and nothing
 * serializes concurrent requests. Every request that reads before the first
 * write lands sees the same count and is admitted, so the overshoot in a burst
 * is bounded by the CALLER'S CONCURRENCY, not by any fixed factor. The limit
 * bounds sequential traffic only.
 */
async function chargeIpCounterInKv(
  kv: KVNamespace,
  prefix: string,
  ip: string,
  limit: number,
): Promise<IpCounterVerdict> {
  const now = Date.now();
  const minuteBucket = Math.floor(now / BUCKET_MS);
  const key = `${prefix}:${ip}:${minuteBucket}`;

  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= limit) {
    const retryAfter = Math.max(
      1,
      Math.ceil(((minuteBucket + 1) * BUCKET_MS - now) / 1000),
    );
    return { limited: true, retryAfter };
  }

  await kv.put(key, String(count + 1), { expirationTtl: TTL_SECONDS });
  return { limited: false, remaining: limit - count - 1 };
}

/**
 * The 429 emitted by both per-IP paths, so their bodies and headers cannot
 * drift. `extraHeaders` carries `X-RateLimit-Remaining`, which only the KV path
 * can report.
 */
function ipRateLimitedResponse(
  c: Context<{ Bindings: Env }>,
  limit: number,
  retryAfter: number,
  extraHeaders: Record<string, string> = {},
): Response {
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
      ...extraHeaders,
    },
  );
}

/**
 * Per-IP rate limit, one of three tiers (see {@link rateLimitBucketFor}).
 *
 * Counting normally runs on Cloudflare's native Rate Limiting binding, which
 * costs zero KV operations. Its semantics, accepted deliberately in exchange
 * for that (documented in docs/architecture.md → 已接受的殘餘風險):
 *
 * - per Cloudflare LOCATION, not global, and eventually consistent — the
 *   platform calls it permissive by design, so it is a brake on abuse, not a
 *   hard bound. Same posture the KV counters had, for a different reason;
 * - no remaining count is exposed, so `X-RateLimit-Remaining` is omitted on
 *   this path (`X-RateLimit-Limit` is still sent);
 * - no reset time is exposed either, so `retryAfter` is the configured period
 *   ({@link BINDING_PERIOD_SECONDS}) rather than the time left in a bucket.
 *
 * When the deployment carries no binding for this tier — a self-hoster whose
 * wrangler.toml predates the rate limiting bindings — the request falls back
 * to {@link chargeIpCounterInKv}, which keeps the previous behavior including
 * both `X-RateLimit-*` headers, and logs `RATE_LIMIT_BINDING_MISSING`.
 */
export const rateLimit = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    // Skip rate limiting in dev mode (local wrangler dev / E2E tests)
    if (isDevMode(c.env)) {
      await next();
      return;
    }

    const ip = getCallerIp(c);
    const { prefix, limit } = rateLimitBucketFor(c.req.method, c.req.path);

    const binding = bindingForWindow(c.env, limit, BINDING_PERIOD_SECONDS);
    if (binding) {
      // Key omits the minute bucket: the binding owns the window. Tiers stay
      // isolated because each keeps its own prefix.
      const { success } = await binding.limit({ key: `${prefix}:${ip}` });
      if (!success) {
        return ipRateLimitedResponse(c, limit, BINDING_PERIOD_SECONDS);
      }
      c.header("X-RateLimit-Limit", String(limit));
      await next();
      return;
    }

    warnMissingRateLimitBinding(limit, BINDING_PERIOD_SECONDS);

    const verdict = await chargeIpCounterInKv(c.env.KV, prefix, ip, limit);
    if (verdict.limited) {
      return ipRateLimitedResponse(c, limit, verdict.retryAfter, {
        "X-RateLimit-Remaining": "0",
      });
    }

    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(verdict.remaining));

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
 * concurrency — there is no fixed overshoot factor. This applies to every
 * counter still on KV: the hourly scopes (`verify`, `verify-write`,
 * `put-books`, `family-prefs`, `family-write`, `public-shelf`), the
 * verification attempt ceiling in `services/verification.ts`, and the
 * missing-binding fallback in {@link chargeIpCounterInKv}. The per-minute
 * scopes normally bypass this path entirely — see {@link bindingForWindow}.
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
 * limits via {@link enforcePerUserRateLimit}, for whichever of them lands on
 * the KV path). Callers that charge only some outcomes use
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
 * Two counting paths, same 429 body. A per-minute scope with its binding
 * configured is counted by Cloudflare's native Rate Limiting binding at zero KV
 * cost, and answers `retryAfter` = the window, since the binding exposes no
 * reset time (semantics and the trade-off: {@link rateLimit}). Everything else
 * — every hourly scope, plus a per-minute scope on a deployment without the
 * binding — goes through {@link consumePerUserRateLimit} exactly as before.
 * This wrapper adds the DEV_MODE bypass, the path choice, and the HTTP
 * rendering; it never counts anything itself.
 */
export async function enforcePerUserRateLimit(
  c: Context<{ Bindings: Env }>,
  opts: PerUserRateLimitOptions,
): Promise<(Response & TypedResponse<ErrorBody, 429, "json">) | null> {
  if (isDevMode(c.env)) return null;

  const binding = bindingForWindow(c.env, opts.max, opts.windowSec);
  if (binding) {
    // Same key shape the KV counter used, minus the window bucket the binding
    // owns. Scope keeps counters independent even when two scopes share a
    // binding because they share a limit.
    const { success } = await binding.limit({
      key: `ratelimit:user:${opts.scope}:${opts.userId}`,
    });
    if (success) return null;

    return jsonError(c, 429, "RATE_LIMITED", RATE_LIMITED_MESSAGE, {
      retryAfter: opts.windowSec,
    });
  }

  warnMissingRateLimitBinding(opts.max, opts.windowSec);

  const verdict = await consumePerUserRateLimit(c.env.KV, opts);
  if (!verdict.limited) return null;

  return jsonError(c, 429, "RATE_LIMITED", RATE_LIMITED_MESSAGE, {
    retryAfter: verdict.retryAfter,
  });
}
