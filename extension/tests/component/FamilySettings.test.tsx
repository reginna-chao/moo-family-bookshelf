import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FamilySettings, FamilySettingsProps } from "@/dialog/FamilySettings";
import type { ApiClient } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn(),
    updateDisplayName: vi.fn().mockResolvedValue({
      data: { userId: "user-abc12345", displayName: "" },
    }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        ownerId: "user-abc12345",
        members: [
          { userId: "user-abc12345", displayName: "小明" },
          { userId: "user-def67890", displayName: "" },
        ],
        maxMembers: 6,
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

  it("saves display name via API and to local/sync storage", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect((screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement).value).toBe("小明");
    });

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), { target: { value: "大明" } });
    fireEvent.click(screen.getByText("儲存"));

    await waitFor(() => {
      expect(apiClient.updateDisplayName).toHaveBeenCalledWith(
        "fam-123", "user-abc12345", "大明",
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ displayName: "大明" });
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({ displayName: "大明" });
    });

    // Should show success feedback
    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("shows API displayName for all members in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      // Owner has displayName "小明" from API
      expect(screen.getByText("小明")).toBeInTheDocument();
      // Other member has empty displayName, falls back to userId slice
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

  it("shows copy sync code button", async () => {
    renderFamilySettings();

    expect(screen.getByText("複製同步碼")).toBeInTheDocument();

    // Wait for async member fetch to complete to avoid act() warning
    await waitFor(() => {
      expect(screen.getByText("小明")).toBeInTheDocument();
    });
  });

  it("shows member list after loading", async () => {
    renderFamilySettings();

    // Wait for member loading to complete
    await waitFor(() => {
      expect(screen.getByText("小明")).toBeInTheDocument();
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // The current user should have a "(你)" indicator
    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("shows leave family button", async () => {
    renderFamilySettings();

    expect(screen.getByText("離開家庭")).toBeInTheDocument();

    // Wait for async member fetch to complete to avoid act() warning
    await waitFor(() => {
      expect(screen.getByText("小明")).toBeInTheDocument();
    });
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

  it("shows (Owner) badge next to the owner in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("(Owner)")).toBeInTheDocument();
    });
  });

  it("owner sees remove and transfer buttons for other members", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });
  });

  it("non-owner does not see remove or transfer buttons", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-123",
          ownerId: "user-def67890",
          members: [
            { userId: "user-abc12345", displayName: "小明" },
            { userId: "user-def67890", displayName: "大明" },
          ],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      }),
    });

    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("大明")).toBeInTheDocument();
    });

    expect(screen.queryByText("移除")).not.toBeInTheDocument();
    expect(screen.queryByText("轉移管理權")).not.toBeInTheDocument();
  });

  it("shows confirmation when clicking remove button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls removeMember API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.removeMember).toHaveBeenCalledWith(
        "fam-123", "user-def67890",
      );
    });

    // fetchMembers should be called again (initial + refresh)
    await waitFor(() => {
      expect(apiClient.getFamilyMembers).toHaveBeenCalledTimes(2);
    });
  });

  it("shows confirmation when clicking transfer button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(screen.getByText("確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。")).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls transferOwnership API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.transferOwnership).toHaveBeenCalledWith(
        "fam-123", "user-abc12345", "user-def67890",
      );
    });

    await waitFor(() => {
      expect(apiClient.getFamilyMembers).toHaveBeenCalledTimes(2);
    });
  });

  it("shows owner-specific error when owner tries to leave", async () => {
    const apiClient = createMockApiClient({
      leaveFamily: vi.fn().mockResolvedValue({
        error: { code: "OWNER_CANNOT_LEAVE", message: "Owner cannot leave" },
      }),
    });
    renderFamilySettings({ apiClient });

    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("確定離開")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定離開"));

    await waitFor(() => {
      expect(screen.getByText("管理者必須先轉移管理權才能離開家庭")).toBeInTheDocument();
    });
  });

  it("cancel confirmation hides confirm dialog in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();
    });

    // Find the cancel button inside the MemberList confirmation (not the leave cancel)
    const cancelButtons = screen.getAllByText("取消");
    fireEvent.click(cancelButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("確定要移除此成員？")).not.toBeInTheDocument();
    });
  });

  it("shows error when removeMember API fails", async () => {
    const apiClient = createMockApiClient({
      removeMember: vi.fn().mockResolvedValue({
        error: { code: "FORBIDDEN", message: "權限不足" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(screen.getByText("權限不足")).toBeInTheDocument();
    });
  });

  it("shows error when updateDisplayName API fails", async () => {
    const apiClient = createMockApiClient({
      updateDisplayName: vi.fn().mockResolvedValue({
        error: { code: "VALIDATION_ERROR", message: "名稱過長" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect((screen.getByPlaceholderText("輸入顯示名稱") as HTMLInputElement).value).toBe("小明");
    });

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), { target: { value: "新名稱" } });
    fireEvent.click(screen.getByText("儲存"));

    await waitFor(() => {
      expect(screen.getByText("名稱過長")).toBeInTheDocument();
      expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    });
  });

  describe("sync archived toggle", () => {
    it("shows '同步封存書籍' toggle switch", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(screen.getByRole("switch", { name: "同步封存書籍" })).toBeInTheDocument();
      });
    });

    it("shows description text for the toggle", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(screen.getByText("啟用後，同步時會一併讀取已封存的書籍")).toBeInTheDocument();
      });
    });

    it("toggle is initially off (aria-checked false)", async () => {
      // Default sendMessage does not call back, so syncArchived stays 0
      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });
    });

    it("toggle reflects initial GET_SYNC_ARCHIVED value of 1", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
      });
    });

    it("clicking toggle sends SET_SYNC_ARCHIVED message", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 0 });
          }
          if (msg.type === "SET_SYNC_ARCHIVED" && callback) {
            callback({ ok: true });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        expect(screen.getByRole("switch", { name: "同步封存書籍" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("switch", { name: "同步封存書籍" }));

      // Should have sent SET_SYNC_ARCHIVED with value 1
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_SYNC_ARCHIVED", syncArchived: 1 }),
        expect.any(Function),
      );
    });

    it("reverts toggle state when SET_SYNC_ARCHIVED response is not ok", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 0 });
          }
          if (msg.type === "SET_SYNC_ARCHIVED" && callback) {
            callback({ ok: false });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });

      fireEvent.click(screen.getByRole("switch", { name: "同步封存書籍" }));

      // Should revert back to false after failed response
      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
      });
    });
  });

  describe("members loading error", () => {
    it("shows error message when getFamilyMembers fails", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "無法載入成員" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("無法載入成員")).toBeInTheDocument();
      });
    });

    it("shows retry button when members fail to load", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "載入失敗" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
        expect(screen.getByText("重試")).toBeInTheDocument();
      });
    });

    it("retry button re-fetches members", async () => {
      const getFamilyMembers = vi.fn()
        .mockResolvedValueOnce({
          error: { code: "INTERNAL_ERROR", message: "載入失敗" },
        })
        .mockResolvedValueOnce({
          data: {
            familyId: "fam-123",
            ownerId: "user-abc12345",
            members: [{ userId: "user-abc12345", displayName: "小明" }],
            maxMembers: 6,
            createdAt: "2026-01-01",
          },
        });

      const apiClient = createMockApiClient({ getFamilyMembers });
      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("重試"));

      await waitFor(() => {
        expect(screen.getByText("小明")).toBeInTheDocument();
      });

      expect(getFamilyMembers).toHaveBeenCalledTimes(2);
    });
  });

  describe("leave family errors", () => {
    it("shows generic error when leave throws an exception", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue(new Error("Network down")),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("Network down")).toBeInTheDocument();
      });

      // Should return to idle state after error
      await waitFor(() => {
        expect(screen.getByText("離開家庭")).toBeInTheDocument();
      });
    });

    it("handles non-Error exception during leave", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue("string error"),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("發生未知錯誤")).toBeInTheDocument();
      });
    });

    it("calls onLeave after successful leave", async () => {
      const onLeave = vi.fn();
      renderFamilySettings({ onLeave });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(onLeave).toHaveBeenCalledOnce();
      });
    });

    it("shows 離開中... during leave process", async () => {
      let resolveLeave: (value: unknown) => void;
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockImplementation(
          () => new Promise((resolve) => { resolveLeave = resolve; }),
        ),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("離開中...")).toBeInTheDocument();
      });

      // Resolve to clean up
      resolveLeave!({ data: { ok: true } });
    });
  });
});
