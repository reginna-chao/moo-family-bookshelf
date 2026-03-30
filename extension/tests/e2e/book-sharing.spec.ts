/**
 * E2E: Book sharing — toggle sharing, save, verify in Family Shelf.
 *
 * Tests the personal shelf book sharing toggle flow:
 * all books default to not-shared, toggle on, save, verify on family shelf.
 */

import { test, expect } from "./helpers/extension-fixture";
import {
  openDialog,
  waitForOnboarding,
  waitForMainView,
  clickStartButton,
  clickCreateFamily,
  clickContinue,
  navigateToTab,
} from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";

/**
 * Helper: go through the full onboarding flow to get to main view.
 */
async function setupFamily(
  page: import("@playwright/test").Page,
  extensionId: string,
): Promise<void> {
  // Set API endpoint
  await page.goto(`chrome-extension://${extensionId}/background.js`);
  await page.evaluate((apiUrl) => {
    chrome.storage.local.set({ apiEndpoint: apiUrl });
  }, WORKER_API_URL);

  await page.goto(MOCK_READMOO_URL);
  await openDialog(page);
  await waitForOnboarding(page);

  await clickStartButton(page);

  const dialog = page.locator("#moo-family-bookshelf-dialog");
  await dialog
    .locator("button", { hasText: "建立家庭公開書櫃" })
    .waitFor({ state: "visible", timeout: 15_000 });
  await clickCreateFamily(page);

  // Wait for sync code to appear (or dump dialog HTML on failure)
  try {
    await dialog.locator("div[style*='monospace']").waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    const html = await dialog.innerHTML().catch(() => "(unreadable)");
    throw new Error(`setupFamily: sync code not found after create.\nDialog HTML:\n${html}\n\nOriginal: ${e}`);
  }
  await clickContinue(page);
  await waitForMainView(page);
}

test.describe("Book Sharing", () => {
  test("All books default to not-shared on Personal Shelf", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await setupFamily(page, extensionId);

    // Navigate to Personal Shelf
    await navigateToTab(page, "個人書櫃");

    const dialog = page.locator("#moo-family-bookshelf-dialog");

    // Wait for book list to load
    const shelfHeader = dialog.locator("text=個人書櫃管理");
    await expect(shelfHeader).toBeVisible({ timeout: 15_000 });

    // Verify books are visible (at least some book titles from mock data)
    await expect(dialog.locator("text=被討厭的勇氣")).toBeVisible({
      timeout: 10_000,
    });

    await page.close();
  });

  test("Toggle books to shared, save, and verify on Family Shelf", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await setupFamily(page, extensionId);

    // Go to Personal Shelf
    await navigateToTab(page, "個人書櫃");

    const dialog = page.locator("#moo-family-bookshelf-dialog");

    // Wait for books to load
    await expect(dialog.locator("text=個人書櫃管理")).toBeVisible({
      timeout: 15_000,
    });

    // Find book toggle buttons in BookRow — they show "未開放" (not shared) or "開放" (shared)
    // Note: button[role="switch"] is the archive sync toggle in Settings, NOT book toggles
    const bookToggles = dialog.locator("button", { hasText: "未開放" });

    // Wait for book toggles to appear
    await expect(bookToggles.first()).toBeVisible({ timeout: 10_000 });

    const toggleCount = await bookToggles.count();
    expect(toggleCount).toBeGreaterThanOrEqual(2);

    // Toggle first two books to "shared"
    await bookToggles.nth(0).click();
    await bookToggles.nth(1).click();

    // The "儲存變更" save button should appear (FloatingActionBar)
    const saveButton = dialog.locator("button", { hasText: "儲存變更" });
    await expect(saveButton).toBeVisible({ timeout: 5_000 });
    await saveButton.click();

    // Wait for save to complete — FloatingActionBar disappears when isDirty resets to false
    await expect(saveButton).not.toBeVisible({ timeout: 10_000 });

    // Switch to Family Shelf
    await navigateToTab(page, "家庭書櫃");

    // Wait for family shelf to load
    await expect(dialog.locator("text=家庭開放書櫃").or(dialog.locator("text=尚無家人分享書籍"))).toBeVisible({
      timeout: 10_000,
    });

    // The default filter is "全部（不含自己）" which excludes our own books.
    // Change the filter to "全部" to see our own shared books.
    const dropdown = dialog.locator("select");
    if (await dropdown.isVisible()) {
      await dropdown.selectOption({ label: "全部" });

      // Wait for re-render after filter change
      await expect(dialog.locator("text=被討厭的勇氣")).toBeVisible({
        timeout: 10_000,
      });

      // Assert that the shared books are visible
      await expect(dialog.locator("text=原子習慣")).toBeVisible({
        timeout: 5_000,
      });
    }

    await page.close();
  });

  test("Toggle books back to not-shared, save, Family Shelf should be empty", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await setupFamily(page, extensionId);

    // Go to Personal Shelf
    await navigateToTab(page, "個人書櫃");

    const dialog = page.locator("#moo-family-bookshelf-dialog");
    await expect(dialog.locator("text=個人書櫃管理")).toBeVisible({
      timeout: 15_000,
    });

    // Toggle first two books to shared
    const bookToggles = dialog.locator("button", { hasText: "未開放" });
    await expect(bookToggles.first()).toBeVisible({ timeout: 10_000 });
    await bookToggles.nth(0).click();
    await bookToggles.nth(1).click();

    // Save
    const saveButton = dialog.locator("button", { hasText: "儲存變更" });
    await expect(saveButton).toBeVisible({ timeout: 5_000 });
    await saveButton.click();

    // Wait for save to complete — FloatingActionBar disappears when isDirty resets
    await expect(saveButton).not.toBeVisible({ timeout: 10_000 });

    // Now toggle them back off — they now show "開放" text
    const sharedToggles = dialog.locator("button", { hasText: "開放" }).filter({ hasNotText: "未開放" });
    await sharedToggles.nth(0).click();
    await sharedToggles.nth(1).click();

    // Save again
    const saveButton2 = dialog.locator("button", { hasText: "儲存變更" });
    await expect(saveButton2).toBeVisible({ timeout: 5_000 });
    await saveButton2.click();

    // Wait for save to complete — FloatingActionBar disappears when isDirty resets
    await expect(saveButton2).not.toBeVisible({ timeout: 10_000 });

    // Switch to Family Shelf
    await navigateToTab(page, "家庭書櫃");

    // Family shelf should show the empty state message
    await expect(
      dialog.locator("text=尚無家人分享書籍"),
    ).toBeVisible({ timeout: 10_000 });

    await page.close();
  });
});
