import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemberList } from "@/components/MemberList";
import { ApiError, BoolFlag, type ApiClient } from "@/api/client";
import {
  buildRetryMessage,
  buildStaticRetryMessage,
} from "@/utils/retryMessage";

const mockRemoveMember = vi.fn();
const mockTransferOwnership = vi.fn();
const mockApiClient = {
  removeMember: mockRemoveMember,
  transferOwnership: mockTransferOwnership,
} as unknown as ApiClient;

const OWNER_ID =
  "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111";
const USER_ID =
  "1111111122222222333333334444444455555555666666667777777788888888";
const OTHER_ID =
  "aabbccdd11223344556677889900aabbccddeeff11223344556677889900aabb";

const defaultProps = {
  members: [
    { userId: OWNER_ID, displayName: "" },
    { userId: USER_ID, displayName: "小明" },
    { userId: OTHER_ID, displayName: "" },
  ],
  ownerId: OWNER_ID,
  userId: USER_ID,
  familyId: "fam-001",
  apiClient: mockApiClient,
  onMembersChanged: vi.fn(),
};

describe("MemberList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders member display names or ID prefix fallback", () => {
    render(<MemberList {...defaultProps} />);

    expect(screen.getByText("aaaaaaaa")).toBeInTheDocument(); // no displayName, fallback
    expect(screen.getByText("小明")).toBeInTheDocument(); // has displayName
    expect(screen.getByText("aabbccdd")).toBeInTheDocument(); // no displayName, fallback
  });

  it("shows Owner badge for the owner member", () => {
    render(<MemberList {...defaultProps} />);

    expect(screen.getByText("管理者")).toBeInTheDocument();
  });

  it("shows (你) badge for the current user", () => {
    render(<MemberList {...defaultProps} />);

    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("owner sees action buttons for non-self members", () => {
    // Current user IS the owner
    render(
      <MemberList {...defaultProps} userId={OWNER_ID} ownerId={OWNER_ID} />,
    );

    // Should see buttons for the other two members
    const transferButtons = screen.getAllByRole("button", {
      name: "轉移管理權",
    });
    const removeButtons = screen.getAllByRole("button", { name: "移除" });
    expect(transferButtons).toHaveLength(2);
    expect(removeButtons).toHaveLength(2);
  });

  it("non-owner does not see action buttons", () => {
    render(<MemberList {...defaultProps} />);

    expect(
      screen.queryByRole("button", { name: "轉移管理權" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "移除" }),
    ).not.toBeInTheDocument();
  });

  it("remove member flow: click 移除 -> confirm -> API call -> onMembersChanged", async () => {
    mockRemoveMember.mockResolvedValue({ data: { ok: true } });

    render(
      <MemberList {...defaultProps} userId={OWNER_ID} ownerId={OWNER_ID} />,
    );

    // Click 移除 on first non-owner member
    const removeButtons = screen.getAllByRole("button", { name: "移除" });
    fireEvent.click(removeButtons[0]);

    // Confirm dialog appears
    expect(screen.getByText("確定要移除成員 小明？")).toBeInTheDocument();

    // Click 確定
    fireEvent.click(screen.getByRole("button", { name: "確定" }));

    await waitFor(() => {
      expect(mockRemoveMember).toHaveBeenCalledWith(
        defaultProps.familyId,
        USER_ID,
      );
    });
    await waitFor(() => {
      expect(defaultProps.onMembersChanged).toHaveBeenCalled();
    });
  });

  it("transfer ownership flow: click 轉移管理權 -> confirm -> API call -> onMembersChanged", async () => {
    mockTransferOwnership.mockResolvedValue({ data: { ok: true } });

    render(
      <MemberList {...defaultProps} userId={OWNER_ID} ownerId={OWNER_ID} />,
    );

    // Click 轉移管理權 on first non-owner member
    const transferButtons = screen.getAllByRole("button", {
      name: "轉移管理權",
    });
    fireEvent.click(transferButtons[0]);

    // Confirm dialog appears
    expect(
      screen.getByText(
        "確定要將管理權轉移給 小明？轉移後你將無法移除其他成員。",
      ),
    ).toBeInTheDocument();

    // Click 確定
    fireEvent.click(screen.getByRole("button", { name: "確定" }));

    await waitFor(() => {
      expect(mockTransferOwnership).toHaveBeenCalledWith(
        defaultProps.familyId,
        OWNER_ID,
        USER_ID,
      );
    });
    await waitFor(() => {
      expect(defaultProps.onMembersChanged).toHaveBeenCalled();
    });
  });

  it("shows error message when action fails", async () => {
    mockRemoveMember.mockResolvedValue({
      error: { code: "FORBIDDEN", message: "權限不足" },
    });

    render(
      <MemberList {...defaultProps} userId={OWNER_ID} ownerId={OWNER_ID} />,
    );

    const removeButtons = screen.getAllByRole("button", { name: "移除" });
    fireEvent.click(removeButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "確定" }));

    await waitFor(() => {
      expect(screen.getByText("權限不足")).toBeInTheDocument();
    });
  });

  it("cancel confirm closes confirm dialog", () => {
    render(
      <MemberList {...defaultProps} userId={OWNER_ID} ownerId={OWNER_ID} />,
    );

    const removeButtons = screen.getAllByRole("button", { name: "移除" });
    fireEvent.click(removeButtons[0]);

    // Confirm dialog is shown
    expect(screen.getByRole("button", { name: "確定" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    // Click 取消
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    // Confirm dialog should be gone, action buttons back
    expect(
      screen.queryByRole("button", { name: "確定" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "移除" })).toHaveLength(2);
  });

  /**
   * The Worker rate-limits the family write endpoints (429 RATE_LIMITED, with
   * an optional `retryAfter`). Its `message` is English, so every write path
   * here renders the localized back-off copy instead — asserted against the
   * production builders, whose literals are pinned in
   * pwa/tests/unit/retryMessage.test.ts.
   *
   * Two shapes reach the component: `updateMemberSettings` THROWS an `ApiError`
   * (the client unwraps its envelope), while `removeMember` /
   * `transferOwnership` RESOLVE an envelope the component reads `res.error` off.
   */
  describe("rate-limited family writes", () => {
    // Local client per test: the module-level `mockApiClient` is shared across
    // the whole file, and these cases assert on call counts.
    function createApiClient(overrides: Partial<ApiClient>): ApiClient {
      return {
        removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
        transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
        updateMemberSettings: vi.fn().mockResolvedValue({ userId: USER_ID }),
        ...overrides,
      } as unknown as ApiClient;
    }

    function renderAsOwner(overrides: Partial<ApiClient>) {
      const onMembersChanged = vi.fn();
      render(
        <MemberList
          {...defaultProps}
          userId={OWNER_ID}
          ownerId={OWNER_ID}
          apiClient={createApiClient(overrides)}
          onMembersChanged={onMembersChanged}
        />,
      );
      return onMembersChanged;
    }

    function toggleCanLendFor(label: string) {
      fireEvent.click(
        screen.getByRole("switch", { name: `允許 ${label} 借出書籍` }),
      );
    }

    it("shows the localized countdown copy when the canLend toggle is rate limited", async () => {
      const onMembersChanged = renderAsOwner({
        updateMemberSettings: vi
          .fn()
          .mockRejectedValue(
            new ApiError("RATE_LIMITED", "Too many requests", 60),
          ),
      });

      toggleCanLendFor("小明");

      await waitFor(() => {
        expect(
          screen.getByText(buildRetryMessage("RATE_LIMITED", 60)),
        ).toBeInTheDocument();
      });
      // Neither the server's English text nor ApiError's "CODE: message" shape.
      expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
      expect(screen.queryByText(/RATE_LIMITED/)).not.toBeInTheDocument();
      // A refused write must not look like it succeeded.
      expect(onMembersChanged).not.toHaveBeenCalled();
    });

    it("shows the static back-off copy when the toggle 429 carried no retryAfter", async () => {
      renderAsOwner({
        updateMemberSettings: vi
          .fn()
          .mockRejectedValue(new ApiError("RATE_LIMITED", "Too many requests")),
      });

      toggleCanLendFor("小明");

      await waitFor(() => {
        expect(
          screen.getByText(buildStaticRetryMessage("RATE_LIMITED")),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
    });

    it("keeps the thrown message for a non-429 ApiError", async () => {
      // Unchanged behaviour: only RATE_LIMITED is rewritten, so every other
      // code still renders ApiError's own "CODE: message" text.
      const err = new ApiError("FORBIDDEN", "not the owner");
      const onMembersChanged = renderAsOwner({
        updateMemberSettings: vi.fn().mockRejectedValue(err),
      });

      toggleCanLendFor("小明");

      await waitFor(() => {
        expect(screen.getByText(err.message)).toBeInTheDocument();
      });
      expect(onMembersChanged).not.toHaveBeenCalled();
    });

    it("falls back to 更新失敗 when the toggle rejects with a non-Error", async () => {
      renderAsOwner({
        updateMemberSettings: vi.fn().mockRejectedValue("boom"),
      });

      toggleCanLendFor("小明");

      await waitFor(() => {
        expect(screen.getByText("更新失敗")).toBeInTheDocument();
      });
    });

    it("shows the localized countdown copy when removeMember is rate limited", async () => {
      const onMembersChanged = renderAsOwner({
        removeMember: vi.fn().mockResolvedValue({
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            retryAfter: 90,
          },
        }),
      });

      fireEvent.click(screen.getAllByRole("button", { name: "移除" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "確定" }));

      await waitFor(() => {
        expect(
          screen.getByText(buildRetryMessage("RATE_LIMITED", 90)),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
      // A refused removal keeps the confirm open and skips the list refresh.
      expect(screen.getByRole("button", { name: "確定" })).toBeInTheDocument();
      expect(onMembersChanged).not.toHaveBeenCalled();
    });

    it("shows the static back-off copy when transferOwnership is rate limited without a retryAfter", async () => {
      const onMembersChanged = renderAsOwner({
        transferOwnership: vi.fn().mockResolvedValue({
          error: { code: "RATE_LIMITED", message: "Too many requests" },
        }),
      });

      fireEvent.click(screen.getAllByRole("button", { name: "轉移管理權" })[0]);
      fireEvent.click(screen.getByRole("button", { name: "確定" }));

      await waitFor(() => {
        expect(
          screen.getByText(buildStaticRetryMessage("RATE_LIMITED")),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument();
      expect(onMembersChanged).not.toHaveBeenCalled();
    });
  });

  describe("readmooName section (read-only on PWA)", () => {
    it("hides readmooName entirely when family has 2 members", () => {
      render(
        <MemberList
          {...defaultProps}
          userId={OWNER_ID}
          ownerId={OWNER_ID}
          members={[
            { userId: OWNER_ID, displayName: "Owner" },
            {
              userId: USER_ID,
              displayName: "小明",
              canLend: BoolFlag.TRUE,
              readmooName: "ming@readmoo",
            },
          ]}
        />,
      );
      expect(
        screen.queryByText(/讀墨名稱：ming@readmoo/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/尚未記錄/)).not.toBeInTheDocument();
    });

    it("shows readmooName read-only when family has >=3 members and value set", () => {
      render(
        <MemberList
          {...defaultProps}
          userId={OWNER_ID}
          ownerId={OWNER_ID}
          members={[
            { userId: OWNER_ID, displayName: "Owner" },
            {
              userId: USER_ID,
              displayName: "小明",
              canLend: BoolFlag.TRUE,
              readmooName: "ming@readmoo",
            },
            {
              userId: OTHER_ID,
              displayName: "Bob",
              canLend: BoolFlag.TRUE,
            },
          ]}
        />,
      );
      expect(screen.getByText(/讀墨名稱：ming@readmoo/)).toBeInTheDocument();
      // PWA must not offer delete/edit affordances
      expect(
        screen.queryByRole("button", { name: /刪除/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("shows '尚未記錄' hint when family has >=3 members and value unset", () => {
      render(
        <MemberList
          {...defaultProps}
          userId={OWNER_ID}
          ownerId={OWNER_ID}
          members={[
            { userId: OWNER_ID, displayName: "Owner" },
            {
              userId: USER_ID,
              displayName: "小明",
              canLend: BoolFlag.TRUE,
            },
            {
              userId: OTHER_ID,
              displayName: "Bob",
              canLend: BoolFlag.TRUE,
            },
          ]}
        />,
      );
      expect(
        screen.getAllByText(/尚未記錄（首次借出時自動建立）/),
      ).toHaveLength(2);
    });

    it("non-owner does not see the readmooName section", () => {
      render(
        <MemberList
          {...defaultProps}
          members={[
            { userId: OWNER_ID, displayName: "Owner" },
            {
              userId: USER_ID,
              displayName: "小明",
              canLend: BoolFlag.TRUE,
              readmooName: "ming@readmoo",
            },
            {
              userId: OTHER_ID,
              displayName: "Bob",
              canLend: BoolFlag.TRUE,
            },
          ]}
        />,
      );
      expect(
        screen.queryByText(/讀墨名稱：ming@readmoo/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/尚未記錄/)).not.toBeInTheDocument();
    });
  });
});
