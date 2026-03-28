/**
 * E2E test helpers for PWA auth state management.
 *
 * The PWA stores auth state in localStorage under the "moo:" prefix.
 * These helpers set/clear that state before tests run.
 */

import type { Page } from "@playwright/test";

export const PWA_URL = "https://localhost:5173";
export const API_URL = "http://localhost:8787";

/** localStorage keys used by useAuth hook */
const STORAGE_KEYS = {
  userId: "moo:userId",
  familyId: "moo:familyId",
  encryptionKey: "moo:encryptionKey",
  apiHost: "moo:apiHost",
  authToken: "moo:authToken",
} as const;

export interface TestAuthState {
  userId: string;
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
  authToken?: string;
}

/**
 * Inject auth state into localStorage so the PWA treats the user as logged in.
 * Must be called after page.goto() since localStorage is origin-scoped.
 */
export async function setAuthState(
  page: Page,
  auth: TestAuthState,
): Promise<void> {
  await page.evaluate(
    ({ keys, auth }) => {
      localStorage.setItem(keys.userId, auth.userId);
      localStorage.setItem(keys.familyId, auth.familyId);
      localStorage.setItem(keys.encryptionKey, auth.encryptionKey);
      if (auth.apiHost) {
        localStorage.setItem(keys.apiHost, auth.apiHost);
      }
      if (auth.authToken) {
        localStorage.setItem(keys.authToken, auth.authToken);
      }
    },
    { keys: STORAGE_KEYS, auth },
  );
}

/**
 * Remove all auth-related localStorage entries.
 */
export async function clearAuthState(page: Page): Promise<void> {
  await page.evaluate((keys) => {
    Object.values(keys).forEach((k) => localStorage.removeItem(k));
  }, STORAGE_KEYS);
}

/**
 * Navigate to the PWA and wait for the page to finish its initial render.
 * Waits until the loading spinner ("載入中...") disappears or the landing page is visible.
 */
export async function navigateAndWaitForLoad(page: Page): Promise<void> {
  await page.goto("/");
  // Wait for React to hydrate — either the landing page form or the main nav should appear
  await page.waitForFunction(
    () => {
      const loading = document.body.textContent?.includes("載入中...");
      return !loading;
    },
    { timeout: 15_000 },
  );
}

/**
 * Set auth state and reload the page so the PWA picks up the new state.
 */
export async function loginAndNavigate(
  page: Page,
  auth: TestAuthState,
): Promise<void> {
  await page.goto("/");
  await setAuthState(page, auth);
  await page.reload();
  await navigateAndWaitForLoad(page);
}

/**
 * Generate a fake 64-character hex user ID for testing.
 */
export function fakeUserId(seed = "test"): string {
  const base = seed.padEnd(64, "0");
  return base.slice(0, 64).replace(/[^a-f0-9]/g, "a");
}

/**
 * Generate a test auth state with reasonable defaults.
 */
export function createTestAuth(overrides?: Partial<TestAuthState>): TestAuthState {
  return {
    userId: fakeUserId("testuser"),
    familyId: "abcd-1234",
    encryptionKey: "testEncryptionKey123",
    authToken: "test-auth-token-abc",
    ...overrides,
  };
}
