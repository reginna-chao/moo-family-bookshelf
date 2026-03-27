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
  // POST /api/auth/hash — derive userId from email
  if (method === "POST" && /^\/api\/auth\/hash\/?$/.test(path)) return true;
  return false;
}
