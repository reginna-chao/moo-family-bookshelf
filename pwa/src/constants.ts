/**
 * Shared constants for the PWA.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_API_ENDPOINT is set via .env.development / .env.production
 */

export const DEFAULT_API_ENDPOINT: string =
  import.meta.env.VITE_API_ENDPOINT ??
  "https://moo-family-bookshelf.rcwork.workers.dev";

/**
 * Valid page routing hashes.
 * Used by both App.tsx (routing) and useAuth.ts (clearUrlParams).
 */
export const PAGE_HASHES = new Set([
  "#family-shelf",
  "#personal-shelf",
  "#settings",
]);
