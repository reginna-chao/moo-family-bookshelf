import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemberList, MemberListProps } from "@/dialog/MemberList";
import { type ApiClient, BoolFlag } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    updateMemberSettings: vi.fn().mockResolvedValue({
      userId: "user-member456",
      displayName: "Bob",
      canLend: BoolFlag.FALSE,
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderMemberList(props: Partial<MemberListProps> = {}) {
  const defaultProps: MemberListProps = {
    members: [
      { userId: "user-owner123", displayName: "Owner" },
      { userId: "user-member456", displayName: "Bob" },
    ],
    ownerId: "user-owner123",
    userId: "user-owner123",
    familyId: "fam-123",
    apiClient: createMockApiClient(),
    onMembersChanged: vi.fn(),
  };
  return render(<MemberList {...defaultProps} {...props} />);
}

describe("MemberList canLend toggle", () => {
  it("shows the canLend toggle for non-self members when current user is owner", () => {
    renderMemberList();

    expect(
      screen.getByRole("switch", { name: /允許 Bob 借出書籍/ }),
    ).toBeInTheDocument();
  });

  it("does NOT show the canLend toggle when current user is not the owner", () => {
    renderMemberList({ userId: "user-member456" });

    // Even though Bob is a member, since current user is not owner, no toggles
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("does NOT show a canLend toggle for the owner's own row", () => {
    renderMemberList();

    // No toggle for the owner-self row
    expect(
      screen.queryByRole("switch", { name: /允許 Owner 借出書籍/ }),
    ).not.toBeInTheDocument();
    // But there is one for the other member
    expect(
      screen.getByRole("switch", { name: /允許 Bob 借出書籍/ }),
    ).toBeInTheDocument();
  });

  it("toggle reflects canLend=TRUE when value is undefined (backward-compat default)", () => {
    renderMemberList({
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob" }, // canLend undefined
      ],
    });

    const toggle = screen.getByRole("switch", { name: /允許 Bob 借出書籍/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggle reflects canLend=TRUE explicitly", () => {
    renderMemberList({
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });

    const toggle = screen.getByRole("switch", { name: /允許 Bob 借出書籍/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("toggle reflects canLend=FALSE explicitly", () => {
    renderMemberList({
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob", canLend: BoolFlag.FALSE },
      ],
    });

    const toggle = screen.getByRole("switch", { name: /允許 Bob 借出書籍/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("clicking toggle on TRUE member calls updateMemberSettings with FALSE", async () => {
    const apiClient = createMockApiClient();
    const onMembersChanged = vi.fn();
    renderMemberList({
      apiClient,
      onMembersChanged,
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });

    fireEvent.click(screen.getByRole("switch", { name: /允許 Bob 借出書籍/ }));

    await waitFor(() => {
      expect(apiClient.updateMemberSettings).toHaveBeenCalledWith(
        "fam-123",
        "user-member456",
        { canLend: BoolFlag.FALSE },
      );
      expect(onMembersChanged).toHaveBeenCalled();
    });
  });

  it("clicking toggle on FALSE member calls updateMemberSettings with TRUE", async () => {
    const apiClient = createMockApiClient({
      updateMemberSettings: vi.fn().mockResolvedValue({
        userId: "user-member456",
        displayName: "Bob",
        canLend: BoolFlag.TRUE,
      }),
    });
    renderMemberList({
      apiClient,
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob", canLend: BoolFlag.FALSE },
      ],
    });

    fireEvent.click(screen.getByRole("switch", { name: /允許 Bob 借出書籍/ }));

    await waitFor(() => {
      expect(apiClient.updateMemberSettings).toHaveBeenCalledWith(
        "fam-123",
        "user-member456",
        { canLend: BoolFlag.TRUE },
      );
    });
  });

  it("renders the help text 「關閉後...」 next to the toggle", () => {
    renderMemberList();

    expect(
      screen.getByText(/關閉後，該成員的書籍不會顯示「申請借閱」按鈕/),
    ).toBeInTheDocument();
  });

  it("shows error message when updateMemberSettings fails", async () => {
    const apiClient = createMockApiClient({
      updateMemberSettings: vi.fn().mockRejectedValue(new Error("更新失敗")),
    });
    renderMemberList({
      apiClient,
      members: [
        { userId: "user-owner123", displayName: "Owner" },
        { userId: "user-member456", displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });

    fireEvent.click(screen.getByRole("switch", { name: /允許 Bob 借出書籍/ }));

    await waitFor(() => {
      expect(screen.getByText("更新失敗")).toBeInTheDocument();
    });
  });
});
