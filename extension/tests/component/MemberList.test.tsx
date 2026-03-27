import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemberList, MemberListProps } from "@/dialog/MemberList";
import type { ApiClient } from "@/api/client";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderMemberList(props: Partial<MemberListProps> = {}) {
  const defaultProps: MemberListProps = {
    members: ["user-owner123", "user-member456"],
    ownerId: "user-owner123",
    userId: "user-owner123",
    familyId: "fam-123",
    apiClient: createMockApiClient(),
    savedDisplayName: "小明",
    onMembersChanged: vi.fn(),
  };
  return render(<MemberList {...defaultProps} {...props} />);
}

describe("MemberList", () => {
  it("renders all members", () => {
    renderMemberList();

    expect(screen.getByText("小明")).toBeInTheDocument();
    expect(screen.getByText("user-mem")).toBeInTheDocument();
  });

  it("shows (Owner) badge for the owner", () => {
    renderMemberList();

    expect(screen.getByText("(Owner)")).toBeInTheDocument();
  });

  it("shows (你) badge for the current user", () => {
    renderMemberList();

    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("owner sees action buttons for non-self members", () => {
    renderMemberList();

    expect(screen.getByText("移除")).toBeInTheDocument();
    expect(screen.getByText("轉移管理權")).toBeInTheDocument();
  });

  it("non-owner does not see action buttons", () => {
    renderMemberList({ userId: "user-member456" });

    expect(screen.queryByText("移除")).not.toBeInTheDocument();
    expect(screen.queryByText("轉移管理權")).not.toBeInTheDocument();
  });

  it("shows remove confirmation dialog", () => {
    renderMemberList();

    fireEvent.click(screen.getByText("移除"));

    expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();
    expect(screen.getByText("確定")).toBeInTheDocument();
    expect(screen.getByText("取消")).toBeInTheDocument();
  });

  it("shows transfer confirmation dialog", () => {
    renderMemberList();

    fireEvent.click(screen.getByText("轉移管理權"));

    expect(
      screen.getByText("確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。"),
    ).toBeInTheDocument();
  });

  it("calls removeMember and onMembersChanged on confirm", async () => {
    const apiClient = createMockApiClient();
    const onMembersChanged = vi.fn();
    renderMemberList({ apiClient, onMembersChanged });

    fireEvent.click(screen.getByText("移除"));
    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.removeMember).toHaveBeenCalledWith(
        "fam-123", "user-member456",
      );
      expect(onMembersChanged).toHaveBeenCalled();
    });
  });

  it("calls transferOwnership and onMembersChanged on confirm", async () => {
    const apiClient = createMockApiClient();
    const onMembersChanged = vi.fn();
    renderMemberList({ apiClient, onMembersChanged });

    fireEvent.click(screen.getByText("轉移管理權"));
    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.transferOwnership).toHaveBeenCalledWith(
        "fam-123", "user-owner123", "user-member456",
      );
      expect(onMembersChanged).toHaveBeenCalled();
    });
  });

  it("cancel hides the confirmation dialog", () => {
    renderMemberList();

    fireEvent.click(screen.getByText("移除"));
    expect(screen.getByText("確定要移除此成員？")).toBeInTheDocument();

    fireEvent.click(screen.getByText("取消"));
    expect(screen.queryByText("確定要移除此成員？")).not.toBeInTheDocument();
  });

  it("shows error when removeMember fails", async () => {
    const apiClient = createMockApiClient({
      removeMember: vi.fn().mockResolvedValue({
        error: { code: "FORBIDDEN", message: "權限不足" },
      }),
    });
    renderMemberList({ apiClient });

    fireEvent.click(screen.getByText("移除"));
    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(screen.getByText("權限不足")).toBeInTheDocument();
    });
  });

  it("shows error when transferOwnership fails", async () => {
    const apiClient = createMockApiClient({
      transferOwnership: vi.fn().mockResolvedValue({
        error: { code: "FORBIDDEN", message: "轉移失敗" },
      }),
    });
    renderMemberList({ apiClient });

    fireEvent.click(screen.getByText("轉移管理權"));
    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(screen.getByText("轉移失敗")).toBeInTheDocument();
    });
  });

  it("uses savedDisplayName for current user", () => {
    renderMemberList({ savedDisplayName: "我的名字" });

    expect(screen.getByText("我的名字")).toBeInTheDocument();
  });

  it("uses userId slice when no savedDisplayName for current user", () => {
    renderMemberList({ savedDisplayName: "" });

    expect(screen.getByText("user-own")).toBeInTheDocument();
  });
});
