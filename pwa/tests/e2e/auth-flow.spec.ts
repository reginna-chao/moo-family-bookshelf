import { test, expect } from "@playwright/test";
import {
  navigateAndWaitForLoad,
  loginAndNavigate,
  createTestAuth,
  clearAuthState,
} from "./helpers/auth-helper";

test.describe("Auth flow", () => {
  test("should show landing page when not authenticated", async ({ page }) => {
    await navigateAndWaitForLoad(page);

    // Landing page heading
    await expect(page.locator("h1")).toContainText("牧家書櫃");
    // Sync code input
    await expect(page.locator("#sync-code")).toBeVisible();
    // Email input
    await expect(page.locator("#email")).toBeVisible();
    // Submit button
    await expect(page.getByRole("button", { name: "開始使用" })).toBeVisible();
  });

  test("should show sync code validation error for invalid code", async ({
    page,
  }) => {
    await navigateAndWaitForLoad(page);

    // Fill invalid sync code and valid email
    await page.locator("#sync-code").fill("invalid-code");
    await page.locator("#email").fill("test@example.com");
    await page.getByRole("button", { name: "開始使用" }).click();

    // Should show sync code error
    await expect(page.locator("#sync-code-error")).toBeVisible();
    await expect(page.locator("#sync-code-error")).toHaveText(
      "同步碼格式不正確，請確認後重新輸入。",
    );
  });

  test("should show email validation error for empty email", async ({
    page,
  }) => {
    await navigateAndWaitForLoad(page);

    // Fill valid sync code but no email
    await page.locator("#sync-code").fill("moo-abcd-1234-testkey123");
    await page.getByRole("button", { name: "開始使用" }).click();

    // Should show email error
    await expect(page.locator("#email-error")).toBeVisible();
    await expect(page.locator("#email-error")).toHaveText("請輸入 Email。");
  });

  // Note: "invalid email format" test is skipped because <input type="email">
  // triggers browser-native validation before handleSubmit runs,
  // so the custom JS error never appears. This is correct behavior.

  test("should return to landing page after logout", async ({ page }) => {
    const auth = createTestAuth();
    await loginAndNavigate(page, auth);

    // Should see the main view with navigation
    await expect(
      page.getByRole("navigation", { name: "主要導覽" }),
    ).toBeVisible();

    // Navigate to settings
    await page.getByRole("button", { name: "設定" }).click();

    // Click logout button
    await page.getByRole("button", { name: "登出" }).click();
    // Confirm logout
    await page.getByRole("button", { name: "確定登出" }).click();

    // Should return to landing page
    await expect(page.locator("h1")).toContainText("牧家書櫃");
    await expect(page.locator("#sync-code")).toBeVisible();
  });
});
