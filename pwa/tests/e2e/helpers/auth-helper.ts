/**
 * E2E test helpers for PWA auth state management.
 *
 * Imports key format from production useAuth to prevent drift.
 */

import type { Page } from "@playwright/test";
import { USER_ID_KEY, namespacedKey } from "@/hooks/useAuth";

export const PWA_URL = "https://localhost:5173";
export const API_URL = "http://localhost:8787";

export interface TestAuthState {
  userId: string;
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
  authToken?: string;
}

/**
 * Inject auth state into localStorage so the PWA treats the user as logged in.
 * Keys are built on the Node side via the production namespacedKey function,
 * then passed as plain strings into page.evaluate — no format duplication.
 * Must be called after page.goto() since localStorage is origin-scoped.
 */
export async function setAuthState(
  page: Page,
  auth: TestAuthState,
): Promise<void> {
  // Build all keys on the Node side using the production helper
  const entries: [string, string][] = [
    [USER_ID_KEY, auth.userId],
    [namespacedKey(auth.userId, "familyId"), auth.familyId],
    [namespacedKey(auth.userId, "encryptionKey"), auth.encryptionKey],
    // Dismiss PwaCreateNotice so it doesn't block interactions
    [namespacedKey(auth.userId, "pwaNoticeShown"), "1"],
  ];
  if (auth.apiHost) {
    entries.push([namespacedKey(auth.userId, "apiHost"), auth.apiHost]);
  }
  if (auth.authToken) {
    entries.push([namespacedKey(auth.userId, "authToken"), auth.authToken]);
  }

  await page.evaluate((pairs) => {
    for (const [key, value] of pairs) {
      localStorage.setItem(key, value);
    }
  }, entries);
}

/**
 * Remove all auth-related localStorage entries.
 */
export async function clearAuthState(page: Page): Promise<void> {
  // Read userId first so we can build namespaced keys
  const userId = await page.evaluate((key) => localStorage.getItem(key), USER_ID_KEY);
  if (userId) {
    const keysToRemove = [
      USER_ID_KEY,
      namespacedKey(userId, "familyId"),
      namespacedKey(userId, "encryptionKey"),
      namespacedKey(userId, "apiHost"),
      namespacedKey(userId, "authToken"),
      namespacedKey(userId, "pwaNoticeShown"),
    ];
    await page.evaluate((keys) => {
      for (const k of keys) localStorage.removeItem(k);
    }, keysToRemove);
  } else {
    await page.evaluate((key) => localStorage.removeItem(key), USER_ID_KEY);
  }
}

/**
 * Navigate to the PWA and wait for the page to finish its initial render.
 * Waits until React has mounted and the landing page or main nav is visible.
 */
export async function navigateAndWaitForLoad(page: Page): Promise<void> {
  await page.goto("/");
  // Wait for React to actually render content — either the landing form or the main nav
  await page.waitForFunction(
    () => {
      const root = document.getElementById("root");
      if (!root || !root.hasChildNodes()) return false;
      // Still loading — wait more
      if (document.body.textContent?.includes("載入中...")) return false;
      return true;
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
