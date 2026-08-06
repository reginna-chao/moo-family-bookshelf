/**
 * Shared route classification utilities.
 * Used by both auth and rate-limit middleware to identify public routes.
 */

/** Routes that don't require authentication and have stricter rate limits. */
export function isPublicRoute(method: string, path: string): boolean {
  // POST /api/family — create family
  if (method === "POST" && /^\/api\/family\/?$/.test(path)) return true;
  // POST /api/family/:id/join — join family
  if (method === "POST" && /^\/api\/family\/[^/]+\/join\/?$/.test(path))
    return true;
  // POST /api/auth/lookup — look up family by userId
  if (method === "POST" && /^\/api\/auth\/lookup\/?$/.test(path)) return true;
  // GET /api/user/:id/verify — check verification method (needed before login)
  if (method === "GET" && /^\/api\/user\/[^/]+\/verify\/?$/.test(path))
    return true;
  // GET /api/public/:shareToken — public bookshelf query
  if (method === "GET" && /^\/api\/public\/[^/]+\/?$/.test(path)) return true;
  // GET /api/_openapi.json + /api/_docs — dev-only API docs (handler gates with isDevMode)
  if (method === "GET" && /^\/api\/_openapi\.json\/?$/.test(path)) return true;
  if (method === "GET" && /^\/api\/_docs\/?$/.test(path)) return true;
  return false;
}

/**
 * Counter buckets on the sensitive tier.
 *
 * Every sensitive route carries the SAME per-minute limit, but not the same
 * counter. `onboarding` (family create / join) and `lookup` are isolated so
 * neither can crowd the other out: one clean onboarding of a verified account
 * spends two lookups (the no-secret probe, then the same call carrying the
 * secret) plus one create / join — three sensitive requests in one minute from
 * one IP. Sharing a single 3/min counter would leave zero headroom for a
 * mistyped PIN, or for a second household member onboarding behind the same NAT
 * / IPv6 /64. Split, that flow costs 2 of 3 in `lookup` and 1 of 3 in
 * `onboarding`.
 */
export type SensitiveBucket = "onboarding" | "lookup";

/**
 * Classify a sensitive public route into its rate-limit bucket, or `null` when
 * the route is not on the sensitive tier.
 *
 * Two kinds of request qualify, and both are entry points of the verification
 * gate (`validateVerification`): those that create a resource for a publicly
 * guessable userId (family create / join), and those where an unauthenticated
 * caller can test a `verifySecret` against someone else's account
 * (`POST /api/auth/lookup`). Lookup is the CHEAPEST oracle of the three — a pure
 * read with no terminal 409 in front of it — so leaving it on the looser public
 * tier would hand an attacker several times the per-IP guess rate on the easiest
 * path.
 *
 * Lookup is classified unconditionally, not only when the body carries a
 * `verifySecret`: the rate-limit middleware runs before any body parsing, so the
 * decision cannot depend on the payload without reading (and buffering) the body
 * on every request — and an attacker would simply always send the field anyway.
 *
 * Isolating lookup's counter does NOT loosen the tier: the limit is unchanged
 * (`RATE_LIMIT_SENSITIVE` in `middleware/rateLimit.ts`), only the key it counts
 * under differs.
 */
export function sensitiveBucketFor(
  method: string,
  path: string,
): SensitiveBucket | null {
  // POST /api/family — create family (squatting prevention)
  if (method === "POST" && /^\/api\/family\/?$/.test(path)) return "onboarding";
  // POST /api/family/:id/join — join family
  if (method === "POST" && /^\/api\/family\/[^/]+\/join\/?$/.test(path))
    return "onboarding";
  // POST /api/auth/lookup — verification-secret oracle (see note above)
  if (method === "POST" && /^\/api\/auth\/lookup\/?$/.test(path))
    return "lookup";
  return null;
}

/**
 * Sensitive public routes that need extra-strict rate limits.
 *
 * Membership of the tier and the bucket split share one set of path patterns —
 * see {@link sensitiveBucketFor} for the classification and its rationale.
 */
export function isSensitivePublicRoute(method: string, path: string): boolean {
  return sensitiveBucketFor(method, path) !== null;
}
