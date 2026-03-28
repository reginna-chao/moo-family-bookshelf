/**
 * Mock server utilities for E2E tests.
 *
 * The primary static file server for fixtures is handled by
 * playwright.config.ts webServer (using `serve`).
 *
 * This module provides URL helpers and route mapping utilities
 * for navigation between mock pages during tests.
 */

/** Base URL for the mock fixture server */
export const FIXTURES_BASE_URL = "http://localhost:4173";

/** Worker API base URL (Miniflare local dev) */
export const WORKER_API_URL = "http://localhost:8787";

/** Mock page URL — single SPA-like page that responds to hash changes */
export const MOCK_READMOO_URL = `${FIXTURES_BASE_URL}/mock-readmoo.html#/library`;

/**
 * @deprecated Use MOCK_READMOO_URL instead. Kept for reference only.
 */
export const MOCK_PAGES = {
  library: MOCK_READMOO_URL,
  me: `${FIXTURES_BASE_URL}/mock-readmoo.html#/me`,
} as const;

/**
 * Override the API endpoint in chrome.storage.local to point to
 * the local Miniflare worker. Should be called via page.evaluate()
 * after the extension loads.
 */
export function getSetApiEndpointScript(apiUrl: string = WORKER_API_URL): string {
  return `
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ apiEndpoint: '${apiUrl}' });
    }
  `;
}

/**
 * Clear all extension storage to reset state between tests.
 * Should be called via page.evaluate().
 */
export const CLEAR_STORAGE_SCRIPT = `
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.clear();
    try { chrome.storage.sync.clear(); } catch(e) {}
  }
`;
