/**
 * Shared constants for the extension.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_API_ENDPOINT is set via .env.development / .env.production
 */

export const DEFAULT_API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT as string;

export const DEFAULT_PWA_URL = import.meta.env.VITE_PWA_URL as string;

export const PERSONAL_BOOKS_CACHE_KEY = "personalBooksCache";

/**
 * Build PWA URL with auth data in the fragment (never sent to server).
 * Format: https://pwa.example.com/#code={syncCode}&uid={userId}
 */
export function buildPwaUrl(syncCode: string, userId: string): string {
  return `${DEFAULT_PWA_URL}/#code=${encodeURIComponent(syncCode)}&uid=${encodeURIComponent(userId)}`;
}
