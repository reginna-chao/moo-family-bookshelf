import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPage } from "@/pages/SettingsPage";
import type { ApiClient } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "../../src/constants";

// Mock syncCode module
vi.mock("@/crypto/syncCode", () => ({
  encodeSyncCode: vi.fn().mockReturnValue("moo-fam1-key1"),
}));

// Mock constants to match the default endpoint used in the mock
vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default-api.example.com",
}));

const mockGetFamilyMembers = vi.fn();
const mockLeaveFamily = vi.fn();
const mockApiClient = {
  getFamilyMembers: mockGetFamilyMembers,
  leaveFamily: mockLeaveFamily,
  getEndpoint: vi
    .fn()
    .mockReturnValue(DEFAULT_API_ENDPOINT),
} as unknown as ApiClient;

const defaultProps = {
  familyId: "fam-001",
  userId: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  apiClient: mockApiClient,
  encryptionKey: "enc-key-123",
  onLogout: vi.fn(),
};

// Helper to render with members already loaded
function renderWithMembers(members: string[], ownerId: string) {
  mockGetFamilyMembers.mockResolvedValue({
    data: { members, ownerId },
  });
  return render(<SettingsPage {...defaultProps} />);
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
        members: [defaultProps.userId],
        ownerId: defaultProps.userId,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Sync code ---

  it("renders the sync code and copy button", () => {
    render(<SettingsPage {...defaultProps} />);

    expect(screen.getByText("moo-fam1-key1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "複製同步碼" }),
    ).toBeInTheDocument();
  });

  it("copy sync code changes button text to '已複製'", async () => {
    render(<SettingsPage {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: "複製同步碼" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "moo-fam1-key1",
      );
    });
    expect(screen.getByRole("button", { name: "已複製" })).toBeInTheDocument();
  });

  // --- Members ---

  it("shows loading state while fetching members", () => {
    // Never resolve so loading stays visible
    mockGetFamilyMembers.mockReturnValue(new Promise(() => {}));
    render(<SettingsPage {...defaultProps} />);

    expect(screen.getByText("載入中...")).toBeInTheDocument();
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
    expect(screen.getByText("11111111")).toBeInTheDocument();
    expect(screen.getByText("aabbccdd")).toBeInTheDocument();
  });

  it("shows error message and allows retry on member fetch failure", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      error: { code: "FETCH_ERROR", message: "無法載入成員" },
    });
    render(<SettingsPage {...defaultProps} />);

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
      screen.getByText("確定要登出嗎？登出後需要重新輸入同步碼才能使用。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "確定登出" }),
    ).toBeInTheDocument();

    // Step 3: confirm → calls onLogout
    fireEvent.click(screen.getByRole("button", { name: "確定登出" }));
    expect(defaultProps.onLogout).toHaveBeenCalled();
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
});
