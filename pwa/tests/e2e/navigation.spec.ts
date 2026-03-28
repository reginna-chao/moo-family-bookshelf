import { test, expect } from "@playwright/test";
import { loginAndNavigate, createTestAuth } from "./helpers/auth-helper";

test.describe("Navigation", () => {
  const auth = createTestAuth();

  test.beforeEach(async ({ page }) => {
    await loginAndNavigate(page, auth);
  });

  test("should show bottom nav with 3 tabs", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "主要導覽" });
    await expect(nav).toBeVisible();

    const buttons = nav.getByRole("button");
    await expect(buttons).toHaveCount(3);

    await expect(buttons.nth(0)).toContainText("家庭書櫃");
    await expect(buttons.nth(1)).toContainText("個人書櫃");
    await expect(buttons.nth(2)).toContainText("設定");
  });

  test("should default to family shelf page after auth", async ({ page }) => {
    // Family shelf tab should be active (aria-current="page")
    const familyTab = page
      .getByRole("navigation", { name: "主要導覽" })
      .getByRole("button", { name: "家庭書櫃" });
    await expect(familyTab).toHaveAttribute("aria-current", "page");
  });

  test("should switch to personal shelf when clicking tab", async ({
    page,
  }) => {
    const nav = page.getByRole("navigation", { name: "主要導覽" });

    await nav.getByRole("button", { name: "個人書櫃" }).click();

    // Personal shelf tab should become active
    const personalTab = nav.getByRole("button", { name: "個人書櫃" });
    await expect(personalTab).toHaveAttribute("aria-current", "page");

    // Family shelf tab should no longer be active
    const familyTab = nav.getByRole("button", { name: "家庭書櫃" });
    await expect(familyTab).not.toHaveAttribute("aria-current", "page");
  });

  test("should switch to settings when clicking tab", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "主要導覽" });

    await nav.getByRole("button", { name: "設定" }).click();

    const settingsTab = nav.getByRole("button", { name: "設定" });
    await expect(settingsTab).toHaveAttribute("aria-current", "page");

    // Settings page heading should be visible
    await expect(page.locator("h2", { hasText: "設定" })).toBeVisible();
  });

  test("should navigate back to family shelf from settings", async ({
    page,
  }) => {
    const nav = page.getByRole("navigation", { name: "主要導覽" });

    // Go to settings first
    await nav.getByRole("button", { name: "設定" }).click();
    await expect(page.locator("h2", { hasText: "設定" })).toBeVisible();

    // Go back to family shelf
    await nav.getByRole("button", { name: "家庭書櫃" }).click();
    const familyTab = nav.getByRole("button", { name: "家庭書櫃" });
    await expect(familyTab).toHaveAttribute("aria-current", "page");
  });
});
