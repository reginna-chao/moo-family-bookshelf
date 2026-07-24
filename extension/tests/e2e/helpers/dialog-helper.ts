/**
 * Helper utilities for interacting with the Dialog UI in E2E tests.
 *
 * The Dialog is injected by the Content Script into the page DOM.
 * - Entry button: #moo-family-bookshelf-btn
 * - Dialog container: #moo-family-bookshelf-dialog
 * - React mount point: #moo-family-bookshelf-root
 * - Backdrop: #moo-family-bookshelf-backdrop
 */

import { type Page, type Locator, expect } from "@playwright/test";

const BUTTON_SELECTOR = "#moo-family-bookshelf-btn";
const DIALOG_SELECTOR = "#moo-family-bookshelf-dialog";
const BACKDROP_SELECTOR = "#moo-family-bookshelf-backdrop";

/**
 * Wait for the mock page to finish loading and Content Script to inject.
 * Call after page.goto(MOCK_READMOO_URL) to avoid flaky blank-page failures.
 */
export async function waitForPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  // Ensure the mock fixture's DOM is present (not a blank page)
  await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
}

/**
 * Wait for the Content Script to inject the "家庭書櫃" button.
 */
export async function waitForButton(page: Page): Promise<Locator> {
  const button = page.locator(BUTTON_SELECTOR);
  await button.waitFor({ state: "visible", timeout: 15_000 });
  return button;
}

/**
 * Open the Dialog by clicking the "家庭書櫃" button.
 * Returns the dialog locator.
 */
export async function openDialog(page: Page): Promise<Locator> {
  const button = await waitForButton(page);
  await button.click();

  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  // Wait for React to mount and finish loading (past "載入中..." state).
  // The dialog App does async chrome.runtime.sendMessage calls on mount,
  // which may be slow in CI — wait for actual content to appear.
  const root = page.locator("#moo-family-bookshelf-root");
  try {
    // First: wait for React to mount anything (including "載入中...")
    await expect(root).not.toBeEmpty({ timeout: 30_000 });
    // Then: wait for the loading state to resolve. Uses a locator (which pierces
    // the open shadow root) rather than document.querySelector in waitForFunction,
    // which cannot cross the shadow boundary.
    await expect(root).not.toContainText("載入中...", { timeout: 30_000 });
  } catch (e) {
    const rootContent = await root.innerHTML().catch(() => "(unreadable)");
    throw new Error(
      `Dialog mount/load failed after 30s.\nRoot HTML: ${rootContent}\n\nOriginal: ${e}`,
    );
  }

  return dialog;
}

/**
 * Close the Dialog by clicking the backdrop.
 */
export async function closeDialog(page: Page): Promise<void> {
  const backdrop = page.locator(BACKDROP_SELECTOR);
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 10, y: 10 } });
    await backdrop.waitFor({ state: "detached", timeout: 5_000 });
  }
}

/**
 * Check if the Dialog is currently open.
 */
export async function isDialogOpen(page: Page): Promise<boolean> {
  return page.locator(DIALOG_SELECTOR).isVisible();
}

/**
 * Navigate to a specific tab in the main view.
 * Tab labels: "家庭書櫃" | "個人書櫃" | "借閱" | "設定"
 */
export async function navigateToTab(
  page: Page,
  tabLabel: "家庭書櫃" | "個人書櫃" | "借閱" | "設定",
): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  const tabButton = dialog.locator("nav button", { hasText: tabLabel });
  await tabButton.click();
  // Wait for tab button to become active (fontWeight 600 indicates selected)
  await expect(tabButton).toHaveCSS("font-weight", "600", { timeout: 5_000 });
}

/**
 * Get the text content of the currently visible dialog view.
 * Useful for assertions about which screen is shown.
 */
export async function getDialogText(page: Page): Promise<string> {
  const dialog = page.locator(DIALOG_SELECTOR);
  return (await dialog.textContent()) ?? "";
}

/**
 * Wait for the Onboarding screen to be visible inside the Dialog.
 */
export async function waitForOnboarding(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  // Onboarding shows "歡迎使用家庭書櫃" heading
  try {
    await dialog.locator("text=歡迎使用家庭書櫃").waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch (e) {
    const html = await dialog.innerHTML().catch(() => "(unreadable)");
    throw new Error(
      `waitForOnboarding failed. Dialog HTML:\n${html}\n\nOriginal: ${e}`,
    );
  }
}

/**
 * Wait for the Main View (tabs) to be visible inside the Dialog.
 *
 * Onboarding's syncBooks step runs scrapeBooks which includes paginateLibrary.
 * The mock Readmoo page has layout but no infinite-scroll behavior — the
 * smart "no-activity" detector exits in ~5.5s, plus fiber bridge wait (~2s),
 * NAV_SETTLE_MS (1.5s), and state transitions. 15s gives ~6s buffer.
 */
export async function waitForMainView(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  // Main view has a nav with tab buttons
  await dialog.locator("nav").waitFor({ state: "visible", timeout: 15_000 });
}

/**
 * Click the "開始使用" button on the Welcome screen.
 * This triggers auto-setup (navigate to #/me, scrape profile).
 */
export async function clickStartButton(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.locator("button", { hasText: "開始使用" }).click();
}

/**
 * Click the "建立家庭公開書櫃" button on the Idle screen.
 */
export async function clickCreateFamily(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.locator("button", { hasText: "建立家庭公開書櫃" }).click();
}

/**
 * Enter a sync code and click "加入家庭公開書櫃".
 */
export async function joinFamily(page: Page, syncCode: string): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.locator('input[placeholder="輸入家庭同步碼"]').fill(syncCode);
  await dialog.locator("button", { hasText: "加入家庭公開書櫃" }).click();
}

/**
 * Get the generated sync code from the CreatedView screen.
 */
export async function getSyncCode(page: Page): Promise<string> {
  const dialog = page.locator(DIALOG_SELECTOR);
  // Sync code is displayed in a span marked with data-testid="sync-code".
  // It is masked by default; click the reveal button to show the real code.
  const codeEl = dialog.locator("[data-testid='sync-code']");
  try {
    await codeEl.waitFor({ state: "visible", timeout: 15_000 });
  } catch (e) {
    const html = await dialog.innerHTML().catch(() => "(unreadable)");
    throw new Error(
      `getSyncCode failed — sync code element not found.\nDialog HTML:\n${html}\n\nOriginal: ${e}`,
    );
  }
  await revealSyncCode(dialog);
  return (await codeEl.textContent())?.trim() ?? "";
}

/**
 * Click the "顯示同步碼" eye button if present so the masked sync code becomes
 * readable. Safe to call even when the reveal button is absent.
 */
async function revealSyncCode(
  dialog: ReturnType<Page["locator"]>,
): Promise<void> {
  const revealBtn = dialog.locator("button[aria-label='顯示同步碼']");
  if ((await revealBtn.count()) > 0) {
    await revealBtn.first().click();
  }
}

/**
 * Click "繼續" button on the CreatedView to proceed after family creation.
 */
export async function clickContinue(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.locator("button", { hasText: "繼續" }).click();
}

/**
 * Get the sync code from the Settings tab.
 */
export async function getSyncCodeFromSettings(page: Page): Promise<string> {
  const dialog = page.locator(DIALOG_SELECTOR);
  // The sync code in settings is in a span marked with data-testid="sync-code".
  // It is masked by default; click the reveal button to show the real code.
  const codeEl = dialog.locator("[data-testid='sync-code']");
  await codeEl.waitFor({ state: "visible", timeout: 10_000 });
  await revealSyncCode(dialog);
  return (await codeEl.textContent())?.trim() ?? "";
}

/**
 * Click "離開家庭" and confirm in the Settings tab.
 */
export async function leaveFamily(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG_SELECTOR);
  await dialog.locator("button", { hasText: "離開家庭" }).click();
  // Wait for confirmation prompt
  await dialog.locator("button", { hasText: "確定離開" }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  await dialog.locator("button", { hasText: "確定離開" }).click();
}
