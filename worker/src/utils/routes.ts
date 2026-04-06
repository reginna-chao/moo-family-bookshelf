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
  // POST /api/auth/refresh — token refresh (uses userId+familyId membership as auth)
  if (method === "POST" && /^\/api\/auth\/refresh\/?$/.test(path)) return true;
  return false;
}
