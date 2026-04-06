/**
 * Valid page routing hashes.
 * Used by both App.tsx (routing) and useAuth.ts (clearUrlParams).
 *
 * Separated from constants.ts to avoid pulling in import.meta.env
 * when imported from Node-side code (e.g., Playwright E2E helpers).
 */
export const PAGE_HASHES = new Set([
  "#family-shelf",
  "#personal-shelf",
  "#settings",
]);
