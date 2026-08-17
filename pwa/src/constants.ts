/**
 * Shared constants for the PWA.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_PWA_API_ENDPOINT is set via root .env files
 */

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";

/**
 * Canonicalised at definition so it lives in the same comparison space as
 * `ApiClient.getEndpoint()` — `VersionWarning` compares the two directly, and a
 * build-time env value with a trailing slash would otherwise read as a
 * self-hosted endpoint.
 *
 * A build whose env value FAILS validation throws here, at module load. That is
 * deliberate: `new ApiClient()` already threw on such a value, so the build was
 * dead either way — failing at the definition names the culprit instead of
 * surfacing as a mystery error deep in the first request.
 */
export const DEFAULT_API_ENDPOINT: string = validateEndpointUrl(
  import.meta.env.VITE_PWA_API_ENDPOINT ||
    "https://moo-family-bookshelf.rcwork.workers.dev",
);

/**
 * Build PWA invite URL with sync code in the fragment (never sent to server).
 * Uses current origin so the URL matches the deployment context.
 */
export function buildInviteUrl(syncCode: string): string {
  return `${window.location.origin}${window.location.pathname}#invite=${encodeURIComponent(syncCode)}`;
}

// PAGE_HASHES moved to routes.ts to avoid import.meta.env side-effects
// when imported from Node-side code (Playwright E2E helpers).
export { PAGE_HASHES } from "./routes";
