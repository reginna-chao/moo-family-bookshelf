import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemberList, type MemberListProps } from "@/dialog/MemberList";
import { BoolFlag, type ApiClient, type FamilyMember } from "@/api/client";

const OWNER_ID = "user-owner123";
const MEMBER_A = "user-membA456";
const MEMBER_B = "user-membB789";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    updateMemberSettings: vi.fn().mockResolvedValue({
      userId: MEMBER_A,
      displayName: "Alice",
      canLend: BoolFlag.TRUE,
    } satisfies FamilyMember),
    ...overrides,
  } as unknown as ApiClient;
}

function renderMemberList(props: Partial<MemberListProps> = {}) {
  const defaultProps: MemberListProps = {
    members: [
      { userId: OWNER_ID, displayName: "Owner" },
      { userId: MEMBER_A, displayName: "Alice", canLend: BoolFlag.TRUE },
      { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
    ],
    ownerId: OWNER_ID,
    userId: OWNER_ID,
    familyId: "fam-123",
    apiClient: createMockApiClient(),
    onMembersChanged: vi.fn(),
  };
  return render(<MemberList {...defaultProps} {...props} />);
}

describe("MemberList readmooName section (extension)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the readmooName section entirely when family has 2 members", () => {
    renderMemberList({
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
      ],
    });
    expect(
      screen.queryByText(/讀墨名稱：alice@readmoo/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/尚未記錄/)).not.toBeInTheDocument();
  });

  it("shows '讀墨名稱：value' + 刪除 button when family has >=3 members and readmooName is set", () => {
    renderMemberList({
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });
    expect(screen.getByText(/讀墨名稱：alice@readmoo/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /刪除 Alice 的讀墨名稱/ }),
    ).toBeInTheDocument();
  });

  it("shows '尚未記錄' hint when family has >=3 members and readmooName is unset", () => {
    renderMemberList();
    // Both Alice and Bob have canLend=TRUE and no readmooName → 2 hints
    expect(screen.getAllByText(/尚未記錄（首次借出時自動建立）/)).toHaveLength(
      2,
    );
  });

  it("does not show the readmooName section for a member whose canLend is FALSE", () => {
    renderMemberList({
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.FALSE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });
    // Alice has canLend FALSE → no readmoo row
    expect(
      screen.queryByText(/讀墨名稱：alice@readmoo/),
    ).not.toBeInTheDocument();
    // Bob still shows the unset hint
    expect(screen.getByText(/尚未記錄/)).toBeInTheDocument();
  });

  it("does not show the readmooName section for the owner's own row", () => {
    renderMemberList({
      members: [
        {
          userId: OWNER_ID,
          displayName: "Owner",
          canLend: BoolFlag.TRUE,
          readmooName: "owner@readmoo",
        },
        { userId: MEMBER_A, displayName: "Alice", canLend: BoolFlag.TRUE },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });
    expect(
      screen.queryByText(/讀墨名稱：owner@readmoo/),
    ).not.toBeInTheDocument();
  });

  it("does not render an <input> for editing readmooName (Wave J removes manual edit)", () => {
    renderMemberList({
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });
    // No text input for readmooName
    expect(
      screen.queryByPlaceholderText(/讀墨顯示名稱/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // No 編輯 affordance either
    expect(screen.queryByText(/編輯/)).not.toBeInTheDocument();
  });

  it("clicking 刪除 calls updateMemberSettings with readmooName: null", async () => {
    const updateMemberSettings = vi.fn().mockResolvedValue({
      userId: MEMBER_A,
      displayName: "Alice",
      canLend: BoolFlag.TRUE,
    } satisfies FamilyMember);
    const onMembersChanged = vi.fn();
    renderMemberList({
      apiClient: createMockApiClient({ updateMemberSettings }),
      onMembersChanged,
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /刪除 Alice 的讀墨名稱/ }),
    );

    await waitFor(() => {
      expect(updateMemberSettings).toHaveBeenCalledWith("fam-123", MEMBER_A, {
        readmooName: null,
      });
      expect(onMembersChanged).toHaveBeenCalled();
    });
  });

  it("surfaces an error message when 刪除 fails", async () => {
    const updateMemberSettings = vi
      .fn()
      .mockRejectedValue(new Error("刪除失敗"));
    renderMemberList({
      apiClient: createMockApiClient({ updateMemberSettings }),
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /刪除 Alice 的讀墨名稱/ }),
    );

    await waitFor(() => {
      expect(screen.getByText("刪除失敗")).toBeInTheDocument();
    });
  });

  it("non-owner does not see the readmooName section even with >=3 members", () => {
    renderMemberList({
      userId: MEMBER_A, // logged in as a non-owner
      members: [
        { userId: OWNER_ID, displayName: "Owner" },
        {
          userId: MEMBER_A,
          displayName: "Alice",
          canLend: BoolFlag.TRUE,
          readmooName: "alice@readmoo",
        },
        { userId: MEMBER_B, displayName: "Bob", canLend: BoolFlag.TRUE },
      ],
    });
    // Section is gated on the canLend toggle, which only the owner sees
    expect(
      screen.queryByText(/讀墨名稱：alice@readmoo/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/尚未記錄/)).not.toBeInTheDocument();
  });
});
