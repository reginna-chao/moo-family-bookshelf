/**
 * E2E: Family lifecycle — create, join, verify members, leave.
 *
 * Tests the complete family lifecycle from onboarding through
 * family creation, member joining via sync code, and leaving.
 */

import { test, expect } from "./helpers/extension-fixture";
import { chromium } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  openDialog,
  closeDialog,
  waitForOnboarding,
  waitForMainView,
  clickStartButton,
  clickCreateFamily,
  clickContinue,
  getSyncCode,
  joinFamily,
  navigateToTab,
  leaveFamily,
  getDialogText,
} from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionPath = resolve(__dirname, "..", "..", "dist");

test.describe("Family Lifecycle", () => {
  test("Dialog button appears on mock library page", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(MOCK_READMOO_URL);

    // Content Script should inject the "家庭書櫃" button
    const button = page.locator("#moo-family-bookshelf-btn");
    await expect(button).toBeVisible({ timeout: 15_000 });
    await expect(button).toHaveText("家庭書櫃");

    await page.close();
  });

  test("Full lifecycle: create family, get sync code, second user joins, verify members, leave", async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    // Multi-browser-context test is inherently flaky (idle page + shared Worker)
    test.info().annotations.push({ type: "flaky", description: "two browser contexts" });

    // --- User 1: Create family ---

    const page1 = await context.newPage();

    // Configure API endpoint to local worker
    await page1.goto(`chrome-extension://${extensionId}/background.js`);
    await page1.evaluate((apiUrl) => {
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    // Navigate to mock page
    await page1.goto(MOCK_READMOO_URL);

    // Open dialog — should show onboarding
    await openDialog(page1);
    await waitForOnboarding(page1);

    // Click "開始使用" — triggers auto-setup (hash changes to #/me then back)
    await clickStartButton(page1);

    // Wait for auto-setup to complete: the "建立家庭公開書櫃" button appears
    const dialog1 = page1.locator("#moo-family-bookshelf-dialog");
    await dialog1
      .locator("button", { hasText: "建立家庭公開書櫃" })
      .waitFor({ state: "visible", timeout: 15_000 });
    await clickCreateFamily(page1);

    // Wait for family creation — sync code should appear
    const syncCodeEl = dialog1.locator("div[style*='monospace']");
    await syncCodeEl.waitFor({ state: "visible", timeout: 15_000 });
    const syncCode = await getSyncCode(page1);
    expect(syncCode).toBeTruthy();
    expect(syncCode).toMatch(/^moo-/);

    // Click "繼續" to proceed to main view
    await clickContinue(page1);
    await waitForMainView(page1);

    // Navigate to Settings tab to verify sync code and member count
    await navigateToTab(page1, "設定");

    const settingsText = await getDialogText(page1);
    expect(settingsText).toContain("家庭成員");

    // --- User 2: Join family using a second persistent context ---

    const useHeadedMode = process.env.E2E_HEADED === "1";
    const context2 = await chromium.launchPersistentContext("", {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-search-engine-choice-screen",
        ...(useHeadedMode ? [] : ["--headless=new"]),
      ],
    });

    try {
      // Wait for second context's service worker
      let sw2 = context2.serviceWorkers()[0];
      if (!sw2) {
        sw2 = await context2.waitForEvent("serviceworker");
      }
      const extensionId2 = sw2.url().split("/")[2];

      const page2 = await context2.newPage();

      // Configure API endpoint for user 2
      await page2.goto(`chrome-extension://${extensionId2}/background.js`);
      await page2.evaluate((apiUrl) => {
        chrome.storage.local.set({ apiEndpoint: apiUrl });
      }, WORKER_API_URL);

      // Navigate to mock page
      await page2.goto(MOCK_READMOO_URL);

      // Change mock email so user 2 gets a unique userId (SHA-256)
      // Use timestamp to avoid KV collisions with previous test runs
      const uniqueEmail = `test-user2-${Date.now()}@readmoo.com`;
      await page2.evaluate((email) => {
        const meView = document.getElementById("me-view");
        if (meView) {
          const emailDiv = meView.querySelector('div[style*="14px"]');
          if (emailDiv) emailDiv.textContent = email;
          const nameDiv = meView.querySelector('div[style*="16px"]');
          if (nameDiv) nameDiv.textContent = "測試使用者 2";
        }
      }, uniqueEmail);

      // Open dialog — should show onboarding
      await openDialog(page2);
      await waitForOnboarding(page2);

      // Click "開始使用" to scrape profile
      await clickStartButton(page2);

      // Wait for idle state (join input visible)
      const dialog2 = page2.locator("#moo-family-bookshelf-dialog");
      await dialog2
        .locator('input[placeholder="輸入家庭同步碼"]')
        .waitFor({ state: "visible", timeout: 15_000 });

      // Join family with sync code from user 1
      await joinFamily(page2, syncCode);

      // Wait for join to complete — should go to main view
      await waitForMainView(page2);

      // Verify user 2 is in the family — navigate to Settings
      await navigateToTab(page2, "設定");
      const user2SettingsText = await getDialogText(page2);
      expect(user2SettingsText).toContain("家庭成員");

      await page2.close();

      // --- Switch back to User 1: verify member count is 2 ---
      // Reload the page to get a fresh state, then reopen dialog
      await page1.goto(MOCK_READMOO_URL);
      await openDialog(page1);
      await waitForMainView(page1);
      await navigateToTab(page1, "設定");

      // Wait for member list to load — should show "家庭成員 (2)"
      await expect(dialog1.getByText("家庭成員 (2)")).toBeVisible({ timeout: 15_000 });
    } finally {
      await context2.close();
    }

    await page1.close();

    // --- Verify sync code format ---
    expect(syncCode).toMatch(/^moo-.+-/);
  });

  test("Opening dialog shows onboarding for fresh state", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Clear any existing state
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
    await openDialog(page);
    await waitForOnboarding(page);

    const text = await getDialogText(page);
    expect(text).toContain("歡迎使用家庭書櫃");
    expect(text).toContain("開始使用");

    await page.close();
  });

  test("Single-member owner can leave and dissolve family", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Set up API endpoint + clear storage from previous tests
    await page.goto(`chrome-extension://${extensionId}/background.js`);
    await page.evaluate((apiUrl) => {
      chrome.storage.local.clear();
      try { chrome.storage.sync.clear(); } catch {}
      chrome.storage.local.set({ apiEndpoint: apiUrl });
    }, WORKER_API_URL);

    await page.goto(MOCK_READMOO_URL);

    // Use a unique email to avoid KV collisions from previous tests
    const uniqueEmail = `test-leave-${Date.now()}@readmoo.com`;
    await page.evaluate((email) => {
      const meView = document.getElementById("me-view");
      if (meView) {
        const emailDiv = meView.querySelector('div[style*="14px"]');
        if (emailDiv) emailDiv.textContent = email;
        const nameDiv = meView.querySelector('div[style*="16px"]');
        if (nameDiv) nameDiv.textContent = "測試離開使用者";
      }
    }, uniqueEmail);

    await openDialog(page);
    await waitForOnboarding(page);

    // Go through onboarding — start, create family
    await clickStartButton(page);

    const dialog = page.locator("#moo-family-bookshelf-dialog");
    await dialog
      .locator("button", { hasText: "建立家庭公開書櫃" })
      .waitFor({ state: "visible", timeout: 15_000 });
    await clickCreateFamily(page);

    // Wait for sync code to appear, then continue
    await dialog.locator("div[style*='monospace']").waitFor({ state: "visible", timeout: 15_000 });
    await clickContinue(page);
    await waitForMainView(page);

    // Navigate to Settings and leave — single-member owner should succeed
    await navigateToTab(page, "設定");
    await expect(dialog.locator("text=離開家庭")).toBeVisible({ timeout: 10_000 });
    await leaveFamily(page);

    // Should return to onboarding after successful leave
    await waitForOnboarding(page);

    await page.close();
  });
});
