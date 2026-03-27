import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FamilySettings, FamilySettingsProps } from "@/dialog/FamilySettings";
import type { ApiClient } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn(),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        members: ["user-abc12345", "user-def67890"],
        createdAt: "2026-01-01",
      },
    }),
    getFamilyBookshelf: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function renderFamilySettings(props: Partial<FamilySettingsProps> = {}) {
  const defaultProps: FamilySettingsProps = {
    familyId: "fam-123",
    userId: "user-abc12345",
    apiClient: createMockApiClient(),
    onLeave: vi.fn(),
  };
  return render(<FamilySettings {...defaultProps} {...props} />);
}

describe("FamilySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return an encryption key and display name from storage
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { encryptionKey: "test-key-xyz", displayName: "小明" };
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
  });

  it("shows display name section with loaded value", async () => {
    renderFamilySettings();

    expect(screen.getByText("顯示名稱")).toBeInTheDocument();
    expect(screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號")).toBeInTheDocument();

    await waitFor(() => {
      const input = screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement;
      expect(input.value).toBe("小明");
    });
  });

  it("save button disabled when display name unchanged", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect((screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement).value).toBe("小明");
    });

    // "儲存" button should be disabled since name hasn't changed
    expect(screen.getByText("儲存")).toBeDisabled();
  });

  it("save button enabled after changing display name", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect((screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement).value).toBe("小明");
    });

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), { target: { value: "大明" } });
    expect(screen.getByText("儲存")).toBeEnabled();
  });

  it("saves display name to local and sync storage", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect((screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement).value).toBe("小明");
    });

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), { target: { value: "大明" } });
    fireEvent.click(screen.getByText("儲存"));

    await waitFor(() => {
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({ displayName: "大明" });
    });

    // Should show success feedback
    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("shows current user display name in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      // Current user should show display name instead of userId slice
      expect(screen.getByText("小明")).toBeInTheDocument();
      // Other member still shows userId slice
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });
  });

  it("shows sync code section", async () => {
    renderFamilySettings();

    expect(screen.getByText("家庭同步碼")).toBeInTheDocument();
    // Wait for sync code to be generated from the encryption key
    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });
  });

  it("shows copy sync code button", () => {
    renderFamilySettings();

    expect(screen.getByText("複製同步碼")).toBeInTheDocument();
  });

  it("shows member list after loading", async () => {
    renderFamilySettings();

    // Wait for member loading to complete
    await waitFor(() => {
      // Current user shows display name, other member shows userId slice
      expect(screen.getByText("小明")).toBeInTheDocument();
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // The current user should have a "(你)" indicator
    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("shows leave family button", () => {
    renderFamilySettings();

    expect(screen.getByText("離開家庭")).toBeInTheDocument();
  });

  it("two-step confirmation: clicking leave shows confirm and cancel", async () => {
    renderFamilySettings();

    // Click the leave button
    fireEvent.click(screen.getByText("離開家庭"));

    // Should now show the confirmation dialog
    await waitFor(() => {
      expect(screen.getByText("確定要離開嗎？")).toBeInTheDocument();
      expect(screen.getByText("確定離開")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Original button should be gone
    expect(screen.queryByText("離開家庭")).not.toBeInTheDocument();
  });

  it("cancel button returns to idle leave state", async () => {
    renderFamilySettings();

    // Enter confirming state
    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Click cancel
    fireEvent.click(screen.getByText("取消"));

    // Should return to idle state with the leave button visible again
    await waitFor(() => {
      expect(screen.getByText("離開家庭")).toBeInTheDocument();
      expect(screen.queryByText("確定離開")).not.toBeInTheDocument();
    });
  });
});
