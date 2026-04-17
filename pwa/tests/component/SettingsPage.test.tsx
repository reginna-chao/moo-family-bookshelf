import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { SettingsPage } from "@/pages/SettingsPage";
import { FamilyDataProvider } from "@/hooks/useFamilyData";
import { BoolFlag, type ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "../../src/constants";

// Mock syncCode module
const { mockEncodeSyncCode } = vi.hoisted(() => ({
  mockEncodeSyncCode: vi.fn().mockReturnValue("moo-fam1-key1"),
}));
vi.mock("@/crypto/syncCode", () => ({
  encodeSyncCode: mockEncodeSyncCode,
}));

// Mock constants to match the default endpoint used in the mock
vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default-api.example.com",
}));

const mockGetFamilyMembers = vi.fn();
const mockGetFamilyBookshelf = vi.fn();
const mockLeaveFamily = vi.fn();
const mockUpdateDisplayName = vi.fn();
const mockDeleteAccount = vi.fn();
const mockApiClient = {
  getFamilyMembers: mockGetFamilyMembers,
  getFamilyBookshelf: mockGetFamilyBookshelf,
  leaveFamily: mockLeaveFamily,
  updateDisplayName: mockUpdateDisplayName,
  deleteAccount: mockDeleteAccount,
  getEndpoint: vi
    .fn()
    .mockReturnValue(DEFAULT_API_ENDPOINT),
} as unknown as ApiClient;

const defaultProps = {
  familyId: "fam-001",
  userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  apiClient: mockApiClient,
  onLogout: vi.fn(),
  onForceLogout: vi.fn(),
};

function renderWithProvider(props = defaultProps) {
  return render(
    <FamilyDataProvider
      familyId={props.familyId}
      userId={props.userId}
      apiClient={props.apiClient}
    >
      <SettingsPage {...props} />
    </FamilyDataProvider>,
  );
}

// Helper to render with members already loaded
function renderWithMembers(memberIds: string[], ownerId: string) {
  const members = memberIds.map((id) => ({ userId: id, displayName: "" }));
  mockGetFamilyMembers.mockResolvedValue({
    data: { members, ownerId },
  });
  return renderWithProvider();
}

describe("SettingsPage", () => {
  beforeEach(() => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    // Default: members load successfully
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "" }],
        ownerId: defaultProps.userId,
      },
    });
    // Default: bookshelf loads successfully (needed by FamilyDataProvider)
    mockGetFamilyBookshelf.mockResolvedValue({
      data: { familyId: defaultProps.familyId, members: [] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Sync code ---

  it("renders the sync code and copy button", async () => {
    renderWithProvider();

    // Wait for async member loading to settle before asserting
    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(screen.getByText(/moo-fam-001-••••/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "複製同步碼" }),
    ).toBeInTheDocument();
  });

  it("copy sync code changes button text to '已複製'", async () => {
    renderWithProvider();

    // Wait for async member loading to settle
    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "複製同步碼" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "moo-fam1-key1",
      );
    });
    expect(screen.getByRole("button", { name: "已複製" })).toBeInTheDocument();
  });

  // --- Members ---

  it("shows loading state while fetching members", async () => {
    // Never resolve so loading stays visible
    mockGetFamilyMembers.mockReturnValue(new Promise(() => {}));
    renderWithProvider();

    // Use findByText to wait for React to flush initial render effects
    expect(await screen.findByText("載入中...")).toBeInTheDocument();
  });

  it("shows member count and member IDs after loading", async () => {
    const member1 =
      "1111111122222222333333334444444455555555666666667777777788888888";
    const member2 =
      "aabbccdd11223344556677889900aabbccddeeff11223344556677889900aabb";
    renderWithMembers([member1, member2], member1);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(screen.getByText("成員 (2)")).toBeInTheDocument();
    // No displayName set, so falls back to userId.slice(0, 8)
    expect(screen.getByText("11111111")).toBeInTheDocument();
    expect(screen.getByText("aabbccdd")).toBeInTheDocument();
  });

  it("shows error message and allows retry on member fetch failure", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      error: { code: "FETCH_ERROR", message: "無法載入成員" },
    });
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByText("無法載入成員")).toBeInTheDocument();
    });
  });

  // --- Leave family ---

  it("shows 離開家庭 button and handles confirm flow", async () => {
    mockLeaveFamily.mockResolvedValue({ data: { ok: true } });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Step 1: click 離開家庭
    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));

    // Step 2: confirm step appears
    expect(
      screen.getByRole("button", { name: "確定離開" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    // Step 3: confirm → calls API → onLogout
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));

    await waitFor(() => {
      expect(mockLeaveFamily).toHaveBeenCalledWith(
        defaultProps.familyId,
        defaultProps.userId,
      );
    });
    await waitFor(() => {
      expect(defaultProps.onLogout).toHaveBeenCalled();
    });
  });

  it("shows error message when leave family returns OWNER_CANNOT_LEAVE", async () => {
    mockLeaveFamily.mockResolvedValue({
      error: {
        code: "OWNER_CANNOT_LEAVE",
        message: "Owner cannot leave",
      },
    });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Click 離開家庭 then confirm
    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));

    await waitFor(() => {
      expect(
        screen.getByText("管理者必須先轉移管理權才能離開家庭"),
      ).toBeInTheDocument();
    });
  });

  // --- Logout ---

  it("shows logout button with confirm dialog flow", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Step 1: click 登出
    fireEvent.click(screen.getByRole("button", { name: "登出" }));

    // Step 2: confirm dialog appears
    expect(
      screen.getByText("確定要登出嗎？同步碼已保留，下次登入免重新輸入。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "確定登出" }),
    ).toBeInTheDocument();

    // Step 3: confirm → calls onLogout
    fireEvent.click(screen.getByRole("button", { name: "確定登出" }));
    expect(defaultProps.onLogout).toHaveBeenCalled();
  });

  it("shows different logout message when remember is set to 0", async () => {
    localStorage.setItem("moo:rememberSyncCode", "0");
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "登出" }));

    expect(
      screen.getByText("確定要登出嗎？登出後需要重新輸入同步碼才能使用。"),
    ).toBeInTheDocument();
  });

  it("cancel logout hides confirm dialog", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "登出" }));
    expect(
      screen.getByRole("button", { name: "確定登出" }),
    ).toBeInTheDocument();

    // Find the 取消 button in the logout section (last one)
    const cancelButtons = screen.getAllByRole("button", { name: "取消" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    // Confirm dialog should be gone, 登出 button back
    expect(
      screen.queryByRole("button", { name: "確定登出" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登出" })).toBeInTheDocument();
  });

  // --- Display name editing ---

  it("shows display name from members and allows editing", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });
    renderWithProvider();

    // Wait for members to load and name to be set
    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Click edit button
    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    expect(input).toBeInTheDocument();
  });

  it("saves updated display name via API", async () => {
    mockUpdateDisplayName.mockResolvedValue({ data: { ok: true } });
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // Edit name
    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(mockUpdateDisplayName).toHaveBeenCalledWith(
        defaultProps.familyId,
        defaultProps.userId,
        "Bob",
      );
    });
  });

  it("dispatches displayNameChanged CustomEvent after successful save", async () => {
    mockUpdateDisplayName.mockResolvedValue({ data: { ok: true } });
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // Edit name
    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(mockUpdateDisplayName).toHaveBeenCalledWith(
        defaultProps.familyId,
        defaultProps.userId,
        "新名字",
      );
    });

    // Verify CustomEvent was dispatched
    await waitFor(() => {
      const dispatchedEvents = dispatchSpy.mock.calls
        .map(([event]) => event)
        .filter((e): e is CustomEvent => e instanceof CustomEvent && e.type === "displayNameChanged");
      expect(dispatchedEvents.length).toBe(1);
      expect(dispatchedEvents[0].detail).toEqual({ displayName: "新名字" });
    });

    dispatchSpy.mockRestore();
  });

  it("does not dispatch CustomEvent when display name update fails", async () => {
    mockUpdateDisplayName.mockResolvedValue({
      error: { code: "INVALID", message: "名稱格式不正確" },
    });
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    fireEvent.change(input, { target: { value: "Bad" } });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(screen.getByText("名稱格式不正確")).toBeInTheDocument();
    });

    // Verify no CustomEvent was dispatched
    const dispatchedEvents = dispatchSpy.mock.calls
      .map(([event]) => event)
      .filter((e): e is CustomEvent => e instanceof CustomEvent && e.type === "displayNameChanged");
    expect(dispatchedEvents.length).toBe(0);

    dispatchSpy.mockRestore();
  });

  it("shows error when display name update fails", async () => {
    mockUpdateDisplayName.mockResolvedValue({
      error: { code: "INVALID", message: "名稱格式不正確" },
    });
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    fireEvent.change(input, { target: { value: "Bad" } });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(screen.getByText("名稱格式不正確")).toBeInTheDocument();
    });
  });

  it("cancels display name editing", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });
    renderWithProvider();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "編輯顯示名稱" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    // Input should be visible
    expect(screen.getByRole("textbox", { name: "顯示名稱" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消修改名稱" }));

    // Should return to display mode — input gone
    expect(screen.queryByRole("textbox", { name: "顯示名稱" })).not.toBeInTheDocument();
  });

  // --- Sync archived toggle ---

  it("toggles sync archived setting", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", { name: "顯示封存書籍" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(`moo:${defaultProps.userId}:syncArchived`)).toBe("1");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(localStorage.getItem(`moo:${defaultProps.userId}:syncArchived`)).toBe("0");
  });

  // --- Version & disclaimer ---

  it("shows version and third-party disclaimer", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(screen.getByText(/墨家書櫃 v/)).toBeInTheDocument();
    expect(screen.getByText("本程式為第三方開發，非 Readmoo 讀墨官方提供。")).toBeInTheDocument();
  });

  // --- Leave family cancel ---

  it("cancel leave family returns to idle state", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    expect(screen.getByRole("button", { name: "確定離開" })).toBeInTheDocument();

    // Click cancel in the leave section
    const cancelButtons = screen.getAllByRole("button", { name: "取消" });
    // Leave cancel is the first 取消 button
    fireEvent.click(cancelButtons[0]);

    expect(screen.getByRole("button", { name: "離開家庭" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確定離開" })).not.toBeInTheDocument();
  });

  // --- Leave family generic error ---

  it("shows generic error when leave family throws", async () => {
    mockLeaveFamily.mockRejectedValue(new Error("Network fail"));
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));

    await waitFor(() => {
      expect(screen.getByText("Network fail")).toBeInTheDocument();
    });
  });

  it("should show @host suffix in masked sync code when custom API is used", async () => {
    mockEncodeSyncCode.mockReturnValue("moo-fam1-key1@custom.api.com");

    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Masked display should include @host suffix
    expect(screen.getByText(/moo-fam-001-••••.*@custom\.api\.com/)).toBeInTheDocument();

    // Restore default mock
    mockEncodeSyncCode.mockReturnValue("moo-fam1-key1");
  });

  // --- Sync code visibility toggle ---

  it("should toggle sync code visibility with eye button", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    // Initially masked
    expect(screen.getByText(/moo-fam-001-••••/)).toBeInTheDocument();

    // Click eye button to reveal
    const showButton = screen.getByRole("button", { name: "顯示同步碼" });
    fireEvent.click(showButton);

    // Now should show full key
    expect(screen.getByText(/moo-fam-001-enc-key-123/)).toBeInTheDocument();
    // Button label should change
    expect(
      screen.getByRole("button", { name: "隱藏同步碼" }),
    ).toBeInTheDocument();
  });

  // --- Delete account ---

  it("renders 移除帳戶 button", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: "移除帳戶" }),
    ).toBeInTheDocument();
  });

  it("shows confirmation card when 移除帳戶 is clicked", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "移除帳戶" }));

    expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
    expect(screen.getByText("將移除墨家書櫃中的所有資料")).toBeInTheDocument();
    expect(screen.getByText("不影響你的讀墨帳號及書籍")).toBeInTheDocument();
    expect(screen.getByText("下次登入時將重新設定")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "確定移除" }),
    ).toBeInTheDocument();
  });

  it("returns to idle when cancel is clicked in delete confirmation", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "移除帳戶" }));
    expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();

    // Find cancel button in delete section (last 取消 since it's after logout section)
    const cancelButtons = screen.getAllByRole("button", { name: "取消" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    expect(screen.queryByText("確定要移除帳戶嗎？")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "移除帳戶" }),
    ).toBeInTheDocument();
  });

  it("calls deleteAccount API and onForceLogout on confirm", async () => {
    mockDeleteAccount.mockResolvedValue({ data: { ok: true } });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "移除帳戶" }));
    fireEvent.click(screen.getByRole("button", { name: "確定移除" }));

    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledWith(defaultProps.userId);
    });
    await waitFor(() => {
      expect(defaultProps.onForceLogout).toHaveBeenCalled();
    });
  });

  it("shows OWNER_CANNOT_DELETE error message", async () => {
    mockDeleteAccount.mockResolvedValue({
      error: {
        code: "OWNER_CANNOT_DELETE",
        message: "Owner cannot delete",
      },
    });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "移除帳戶" }));
    fireEvent.click(screen.getByRole("button", { name: "確定移除" }));

    await waitFor(() => {
      expect(
        screen.getByText("管理者必須先轉移管理權才能移除帳戶"),
      ).toBeInTheDocument();
    });
  });

  it("shows generic error when delete account throws", async () => {
    mockDeleteAccount.mockRejectedValue(new Error("Network error"));
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "移除帳戶" }));
    fireEvent.click(screen.getByRole("button", { name: "確定移除" }));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });
});
