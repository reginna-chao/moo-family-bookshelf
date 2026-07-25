import { test, expect } from "@playwright/test";
import {
  loginAndNavigate,
  createTestAuth,
  mockDefaultApiRoutes,
} from "./helpers/auth-helper";

test.describe("Settings page", () => {
  const auth = createTestAuth();

  test.beforeEach(async ({ page }) => {
    // Install default mocks first
    await mockDefaultApiRoutes(page, auth);

    // Override members API with 2-member response (LIFO: last registered wins)
    await page.route("**/api/family/*/members", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            familyId: auth.familyId,
            ownerId: auth.userId,
            members: [
              { userId: auth.userId, displayName: "測試使用者" },
              {
                userId: "b".repeat(64),
                displayName: "家人A",
              },
            ],
            maxMembers: 6,
            createdAt: "2025-01-01T00:00:00Z",
          },
        }),
      });
    });

    await loginAndNavigate(page, auth, { skipDefaultMocks: true });

    // Navigate to settings tab
    await page
      .getByRole("navigation", { name: "主要導覽" })
      .getByRole("button", { name: "設定" })
      .click();

    await expect(page.locator("h2", { hasText: "設定" })).toBeVisible();
  });

  test("should show member list with correct member count", async ({
    page,
  }) => {
    // Wait for members to load
    await expect(page.locator("text=成員 (2)")).toBeVisible({
      timeout: 10_000,
    });

    // Check that both members are listed in the member list
    const memberSection = page.locator("text=成員 (2)").locator("..");
    await expect(
      memberSection.locator("text=測試使用者").first(),
    ).toBeVisible();
    await expect(page.locator("text=家人A")).toBeVisible();

    // Owner badge should be shown for the current user
    await expect(page.locator("text=管理者")).toBeVisible();
    // "(你)" badge for current user
    await expect(page.locator("text=(你)")).toBeVisible();
  });

  test("should show leave family button and confirmation dialog", async ({
    page,
  }) => {
    // Leave family button should be visible
    const leaveButton = page.getByRole("button", { name: "離開家庭" });
    await expect(leaveButton).toBeVisible();

    // Click it — should show confirmation
    await leaveButton.click();

    // Confirmation buttons should appear
    await expect(page.getByRole("button", { name: "確定離開" })).toBeVisible();
    await expect(page.getByRole("button", { name: "取消" })).toBeVisible();

    // Click cancel — should go back to idle state
    await page.getByRole("button", { name: "取消" }).click();
    await expect(leaveButton).toBeVisible();
  });

  test("should show sync code section", async ({ page }) => {
    // Sync code section heading
    await expect(page.locator("text=家庭同步碼")).toBeVisible();

    // Copy button
    await expect(
      page.getByRole("button", { name: "複製同步碼" }),
    ).toBeVisible();

    // The sync code itself should contain the family ID
    const syncCodeBlock = page.locator(".font-mono.break-all");
    const syncCodeText = await syncCodeBlock.textContent();
    expect(syncCodeText).toContain("moo-");
  });
});
