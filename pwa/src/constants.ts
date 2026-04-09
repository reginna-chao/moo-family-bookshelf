/**
 * Shared constants for the PWA.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_PWA_API_ENDPOINT is set via root .env files
 */

export const DEFAULT_API_ENDPOINT: string =
  import.meta.env.VITE_PWA_API_ENDPOINT ??
  "https://moo-family-bookshelf.rcwork.workers.dev";

// PAGE_HASHES moved to routes.ts to avoid import.meta.env side-effects
// when imported from Node-side code (Playwright E2E helpers).
export { PAGE_HASHES } from "./routes";
