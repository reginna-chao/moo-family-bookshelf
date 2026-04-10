/**
 * E2E: Dialog state machine — onboarding, main view, persistence, leave.
 *
 * Tests the dialog state transitions:
 * - Fresh state -> Onboarding
 * - After family creation -> Main View with 3 tabs
 * - Close & reopen -> persists on Main View
 * - Leave family -> back to Onboarding
 */

import { test, expect } from "./helpers/extension-fixture";
import {
  openDialog,
  closeDialog,
  isDialogOpen,
  waitForOnboarding,
  waitForMainView,
  clickStartButton,
  clickCreateFamily,
  clickContinue,
  navigateToTab,
  leaveFamily,
  getDialogText,
  waitForPageReady,
} from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";

/**
 * Helper: go through full onboarding to reach main view.
 */
async function goThroughOnboarding(
  page: import("@playwright/test").Page,
): Promise<void> {
  await clickStartButton(page);

  const dialog = page.locator("#moo-family-bookshelf-dialog");
  await dialog
    .locator("button", { hasText: "建立家庭公開書櫃" })
    .waitFor({ state: "visible", timeout: 15_000 });
  await clickCreateFamily(page);

  // Wait for sync code to appear (or dump dialog HTML on failure)
  try {
    await dialog.locator("[data-testid='sync-code']").waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    const html = await dialog.innerHTML().catch(() => "(unreadable)");
    throw new Error(`goThroughOnboarding: sync code not found.\nDialog HTML:\n${html}\n\nOriginal: ${e}`);
  }
  await clickContinue(page);
  await waitForMainView(page);
}

test.describe("Dialog State Machine", () => {
  test("Fresh state shows Onboarding", async ({ context, extensionId }) => {
    const page = await context.newPage();

    // Clear all state
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate(() => {
      chrome.storage.local.clear();
      try {
        chrome.storage.sync.clear();
      } catch {
        // sync may not be available
      }
    });

    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);
    await openDialog(page);
    await waitForOnboarding(page);

    const text = await getDialogText(page);
    expect(text).toContain("歡迎使用家庭書櫃");

    await page.close();
  });

  test("After family creation, shows Main View with 3 tabs", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Set API endpoint
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate((apiUrl) => {
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);
    await openDialog(page);
    await waitForOnboarding(page);

    // Go through onboarding
    await goThroughOnboarding(page);

    // Verify 3 tab buttons exist
    const dialog = page.locator("#moo-family-bookshelf-dialog");
    const tabNav = dialog.locator("nav");
    await expect(tabNav).toBeVisible();

    const tabButtons = tabNav.locator("button");
    await expect(tabButtons).toHaveCount(3);

    // Verify tab labels
    await expect(tabButtons.nth(0)).toHaveText("家庭書櫃");
    await expect(tabButtons.nth(1)).toHaveText("個人書櫃");
    await expect(tabButtons.nth(2)).toHaveText("設定");

    await page.close();
  });

  test("Close and reopen preserves Main View", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Set up with family
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate((apiUrl) => {
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);
    await openDialog(page);
    await waitForOnboarding(page);

    await goThroughOnboarding(page);

    // Close dialog
    await closeDialog(page);
    expect(await isDialogOpen(page)).toBe(false);

    // Reopen dialog — should still show Main View (persisted via storage)
    await openDialog(page);
    await waitForMainView(page);

    // Verify tabs are still visible
    const tabNav = page.locator("#moo-family-bookshelf-dialog nav");
    await expect(tabNav).toBeVisible();
    await expect(tabNav.locator("button")).toHaveCount(3);

    await page.close();
  });

  test("Single-member owner can leave family and return to onboarding", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Set up with family — clear storage and use unique email to avoid KV collisions
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate((apiUrl) => {
      chrome.storage.local.clear();
      try { chrome.storage.sync.clear(); } catch {}
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);

    const uniqueEmail = `test-dsm-leave-${Date.now()}@readmoo.com`;
    await page.evaluate((email) => {
      const meView = document.getElementById("me-view");
      if (meView) {
        const emailDiv = meView.querySelector('div[style*="14px"]');
        if (emailDiv) emailDiv.textContent = email;
      }
    }, uniqueEmail);

    await openDialog(page);
    await waitForOnboarding(page);

    await goThroughOnboarding(page);

    // Go to Settings tab and leave
    await navigateToTab(page, "設定");

    const dialog = page.locator("#moo-family-bookshelf-dialog");
    await expect(dialog.locator("text=離開家庭")).toBeVisible({ timeout: 10_000 });
    await leaveFamily(page);

    // Single-member owner should successfully leave — returns to onboarding
    await waitForOnboarding(page);

    await page.close();
  });

  test("Clearing family state returns to Onboarding", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Set up with family — clear storage and use unique email to avoid KV collisions
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate((apiUrl) => {
      chrome.storage.local.clear();
      try { chrome.storage.sync.clear(); } catch {}
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);

    const uniqueEmail = `test-dsm-clear-${Date.now()}@readmoo.com`;
    await page.evaluate((email) => {
      const meView = document.getElementById("me-view");
      if (meView) {
        const emailDiv = meView.querySelector('div[style*="14px"]');
        if (emailDiv) emailDiv.textContent = email;
      }
    }, uniqueEmail);
    await openDialog(page);
    await waitForOnboarding(page);

    await goThroughOnboarding(page);

    // Verify we're in main view
    await waitForMainView(page);

    // Simulate losing family state (e.g., non-owner leaving or storage cleared)
    // chrome.storage is only accessible on chrome-extension:// pages
    await closeDialog(page);
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate(() => {
      chrome.storage.local.remove(["familyId"]);
      chrome.storage.sync.remove(["familyId"]);
    });

    // Navigate back and reopen dialog — should show Onboarding
    await page.goto(MOCK_READMOO_URL);
    await waitForPageReady(page);
    await openDialog(page);
    await waitForOnboarding(page);
    const text = await getDialogText(page);
    expect(text).toContain("歡迎使用家庭書櫃");

    await page.close();
  });
});
