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
  if (method === "GET" && /^\/api\/user\/[^/]+\/verify\/?$/.test(path)) return true;
  return false;
}
