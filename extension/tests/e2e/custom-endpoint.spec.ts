/**
 * E2E: Custom API endpoint — sync code @host suffix, auto-configure.
 *
 * Tests:
 * - Sync code format is valid
 * - Sync code includes @host since localhost:8787 is not the production default
 * - Sync code is parseable with expected segments
 */

import { test, expect } from "./helpers/extension-fixture";
import {
  openDialog,
  waitForOnboarding,
  waitForMainView,
  clickStartButton,
  clickCreateFamily,
  clickContinue,
  getSyncCode,
  navigateToTab,
  getSyncCodeFromSettings,
} from "./helpers/dialog-helper";
import { MOCK_READMOO_URL, WORKER_API_URL } from "./helpers/mock-server";

/**
 * Helper: go through onboarding and create a family, returning the sync code.
 */
async function createFamilyAndGetSyncCode(
  page: import("@playwright/test").Page,
  extensionId: string,
): Promise<string> {
  // Capture all MooFamily logs for debugging
  const logs: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("[MooFamily]")) logs.push(msg.text());
  });

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

  // Wait for sync code to appear (or dump dialog HTML + logs on failure)
  try {
    await dialog.locator("div[style*='monospace']").waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    const html = await dialog.innerHTML().catch(() => "(unreadable)");
    throw new Error(
      `createFamilyAndGetSyncCode failed.\nLogs: ${logs.join(" | ")}\nDialog HTML: ${html}\nOriginal: ${e}`,
    );
  }
  const syncCode = await getSyncCode(page);
  return syncCode;
}

test.describe("Custom API Endpoint", () => {
  test("Sync code includes @host when using localhost worker", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Create family with the real local worker (localhost:8787)
    const syncCode = await createFamilyAndGetSyncCode(page, extensionId);
    expect(syncCode).toBeTruthy();
    expect(syncCode).toMatch(/^moo-/);

    // Since localhost:8787 is NOT the default production endpoint
    // (DEFAULT_API_ENDPOINT is a Cloudflare Workers URL from env),
    // the sync code SHOULD contain @host with the localhost URL.
    expect(syncCode).toContain("@");
    expect(syncCode).toMatch(/@https?:\/\/localhost/);

    await page.close();
  });

  test("Sync code is visible in Settings tab after creation", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    // Create family and get sync code during creation
    const syncCodeOnCreate = await createFamilyAndGetSyncCode(page, extensionId);
    expect(syncCodeOnCreate).toBeTruthy();

    // Continue to main view
    await clickContinue(page);
    await waitForMainView(page);

    // Go to Settings tab and verify sync code is visible
    await navigateToTab(page, "設定");

    const settingsSyncCode = await getSyncCodeFromSettings(page);
    expect(settingsSyncCode).toBeTruthy();
    expect(settingsSyncCode).toMatch(/^moo-/);

    // Both sync codes should match
    expect(settingsSyncCode).toBe(syncCodeOnCreate);

    await page.close();
  });

  test("Sync code format is valid and parseable", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();

    const syncCode = await createFamilyAndGetSyncCode(page, extensionId);

    // Parse the sync code format: moo-{part1}-{part2}-{key}[@host]
    const atIndex = syncCode.indexOf("@");
    const mainPart = atIndex !== -1 ? syncCode.slice(0, atIndex) : syncCode;
    const hostPart = atIndex !== -1 ? syncCode.slice(atIndex + 1) : null;

    const segments = mainPart.split("-");
    // At minimum: moo, familyId part 1, familyId part 2, encryption key
    expect(segments.length).toBeGreaterThanOrEqual(4);
    expect(segments[0]).toBe("moo");
    // Family ID parts should not be empty
    expect(segments[1].length).toBeGreaterThan(0);
    expect(segments[2].length).toBeGreaterThan(0);
    // Encryption key should not be empty
    expect(segments.slice(3).join("-").length).toBeGreaterThan(0);

    // If host is present, it should be a valid URL
    if (hostPart) {
      expect(hostPart).toMatch(/^https?:\/\//);
    }

    await page.close();
  });
});
