/**
 * Shared constants for the extension.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_EXTENSION_API_ENDPOINT / VITE_EXTENSION_PWA_URL are set via root .env files
 */

export const DEFAULT_API_ENDPOINT: string =
  import.meta.env.VITE_EXTENSION_API_ENDPOINT ||
  "https://moo-family-bookshelf-dev.rcwork.workers.dev";

export const DEFAULT_PWA_URL: string =
  import.meta.env.VITE_EXTENSION_PWA_URL || "https://moo-family-bookshelf-dev.pages.dev";

export const PERSONAL_BOOKS_CACHE_KEY = "personalBooksCache";

/**
 * Build PWA URL with auth data in the fragment (never sent to server).
 * Format: https://pwa.example.com/#code={syncCode}&uid={userId}
 */
export function buildPwaUrl(syncCode: string, userId: string): string {
  return `${DEFAULT_PWA_URL}/#code=${encodeURIComponent(syncCode)}&uid=${encodeURIComponent(userId)}`;
}

/**
 * Build PWA invite URL with sync code in the fragment (never sent to server).
 * Format: https://pwa.example.com/#invite={syncCode}
 */
export function buildInviteUrl(syncCode: string): string {
  return `${DEFAULT_PWA_URL}/#invite=${encodeURIComponent(syncCode)}`;
}
