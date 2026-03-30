/**
 * E2E test helpers for PWA auth state management.
 *
 * The PWA stores auth state in localStorage under the "moo:" prefix.
 * These helpers set/clear that state before tests run.
 */

import type { Page } from "@playwright/test";

export const PWA_URL = "https://localhost:5173";
export const API_URL = "http://localhost:8787";

/** Bootstrap key (global, not namespaced) — must match useAuth.ts */
const USER_ID_KEY = "moo:userId";

/** Build namespaced key: moo:{userId}:{suffix} — must match useAuth.ts */
function namespacedKey(userId: string, suffix: string): string {
  return `moo:${userId}:${suffix}`;
}

export interface TestAuthState {
  userId: string;
  familyId: string;
  encryptionKey: string;
  apiHost?: string;
  authToken?: string;
}

/**
 * Inject auth state into localStorage so the PWA treats the user as logged in.
 * Uses the same namespaced key format as useAuth.ts: moo:{userId}:{field}
 * Must be called after page.goto() since localStorage is origin-scoped.
 */
export async function setAuthState(
  page: Page,
  auth: TestAuthState,
): Promise<void> {
  await page.evaluate(
    ({ userIdKey, auth }) => {
      const ns = (suffix: string) => `moo:${auth.userId}:${suffix}`;
      localStorage.setItem(userIdKey, auth.userId);
      localStorage.setItem(ns("familyId"), auth.familyId);
      localStorage.setItem(ns("encryptionKey"), auth.encryptionKey);
      if (auth.apiHost) {
        localStorage.setItem(ns("apiHost"), auth.apiHost);
      }
      if (auth.authToken) {
        localStorage.setItem(ns("authToken"), auth.authToken);
      }
    },
    { userIdKey: USER_ID_KEY, auth },
  );
}

/**
 * Remove all auth-related localStorage entries.
 */
export async function clearAuthState(page: Page): Promise<void> {
  await page.evaluate((userIdKey) => {
    const userId = localStorage.getItem(userIdKey);
    if (userId) {
      const ns = (suffix: string) => `moo:${userId}:${suffix}`;
      localStorage.removeItem(ns("familyId"));
      localStorage.removeItem(ns("encryptionKey"));
      localStorage.removeItem(ns("apiHost"));
      localStorage.removeItem(ns("authToken"));
    }
    localStorage.removeItem(userIdKey);
  }, USER_ID_KEY);
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
