import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import React from "react";
import { SettingsPage } from "@/pages/SettingsPage";
import { FamilyDataProvider, useFamilyData } from "@/hooks/useFamilyData";
import {
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "@/components/UnkickNotice";
import { BoolFlag, type ApiClient } from "@/api/client";
import { buildRetryMessage } from "@/utils/retryMessage";
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
const mockRemoveMember = vi.fn();
const mockUnkickMember = vi.fn();
const mockApiClient = {
  getFamilyMembers: mockGetFamilyMembers,
  getFamilyBookshelf: mockGetFamilyBookshelf,
  leaveFamily: mockLeaveFamily,
  updateDisplayName: mockUpdateDisplayName,
  deleteAccount: mockDeleteAccount,
  removeMember: mockRemoveMember,
  unkickMember: mockUnkickMember,
  getEndpoint: vi.fn().mockReturnValue(DEFAULT_API_ENDPOINT),
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

/**
 * A bare consumer of the FamilyData context. Renders the members the provider
 * currently holds so a test can assert what `updateMemberDisplayName` pushed
 * into the shared context (the direct-call replacement for the removed
 * `displayNameChanged` CustomEvent), independent of SettingsPage's own UI.
 */
function MembersProbe() {
  const { members } = useFamilyData();
  return (
    <ul data-testid="members-probe">
      {members.map((m) => (
        <li key={m.userId}>{m.displayName}</li>
      ))}
    </ul>
  );
}

function renderWithProbe(props = defaultProps) {
  return render(
    <FamilyDataProvider
      familyId={props.familyId}
      userId={props.userId}
      apiClient={props.apiClient}
    >
      <SettingsPage {...props} />
      <MembersProbe />
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

    expect(screen.getByText("moo-fam1-key1")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "複製同步碼" }),
    ).toBeInTheDocument();
  });

  it("copy sync code changes button text to '已複製'", async () => {
    // act is the readiness barrier: on exit the member-load effects have been
    // flushed. A `queryByText("載入中...")` waiter only proves the spinner left
    // the DOM, which is not the same as the load's effects having committed.
    await act(async () => {
      renderWithProvider();
    });
    // getBy, not findBy: the settled view must be committed, not merely coming.
    const copyButton = screen.getByRole("button", { name: "複製同步碼" });

    fireEvent.click(copyButton);

    // Clipboard now receives a welcome message that embeds the sync code
    // (full wording is covered by inviteMessages.test.ts).
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("moo-fam1-key1"),
      );
    });
    // `handleCopy` awaits clipboard.writeText, so `setCopied(true)` commits a
    // microtask after the click — the waitFor above only proves writeText was
    // CALLED. This must stay findBy*: an eventual-state assertion, not getBy*.
    expect(
      await screen.findByRole("button", { name: "已複製" }),
    ).toBeInTheDocument();
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

  // --- Un-kick entry after a removal ---

  /**
   * Removing a member writes a 6-hour server-side block on rejoining, so the
   * owner gets an entry to lift it again (see `UnkickNotice`). This page — not
   * `MemberList` — owns that entry, precisely so it survives the member refresh
   * the removal triggers: a failed refresh unmounts the list, and swallowing the
   * entry with it would leave the owner no way to undo a mis-click.
   */
  describe("un-kick entry after a removal", () => {
    const SELF_ID = defaultProps.userId;
    const REMOVED_ID =
      "1111111122222222333333334444444455555555666666667777777788888888";
    const THIRD_ID =
      "aabbccdd11223344556677889900aabbccddeeff11223344556677889900aabb";

    function membersResponse(ownerId: string) {
      return {
        data: {
          members: [
            { userId: SELF_ID, displayName: "小明" },
            { userId: REMOVED_ID, displayName: "大明" },
            { userId: THIRD_ID, displayName: "阿華" },
          ],
          ownerId,
        },
      };
    }

    beforeEach(() => {
      mockGetFamilyMembers.mockResolvedValue(membersResponse(SELF_ID));
      mockRemoveMember.mockResolvedValue({ data: { ok: true } });
      mockUnkickMember.mockResolvedValue({ data: { cleared: BoolFlag.TRUE } });
    });

    /**
     * `removedAt` is what makes the notice's `key` unique PER REMOVAL, and the
     * real clock can put two removals of the same member in the same
     * millisecond. Pin it so the second-removal regression below actually
     * exercises the remount instead of passing or failing on timing luck.
     */
    let restoreClock: (() => void) | null = null;

    function controlClock(startMs: number) {
      let now = startMs;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      restoreClock = () => spy.mockRestore();
      return {
        advance(ms: number) {
          now += ms;
        },
      };
    }

    afterEach(() => {
      // The outer `clearAllMocks` only clears calls, not implementations, and
      // these two mocks are set up nowhere else — drop them so no later test in
      // this file inherits a removal/un-kick that silently succeeds.
      mockRemoveMember.mockReset();
      mockUnkickMember.mockReset();
      restoreClock?.();
      restoreClock = null;
    });

    /**
     * Mount and settle the initial member load. `act` is the readiness signal
     * rather than `findBy*`: the interactions below depend on state published by
     * the provider's mount effect, and only `act` guarantees it has committed.
     */
    async function renderSettled() {
      await act(async () => {
        renderWithProvider();
      });
      await waitFor(() => {
        expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
      });
    }

    /**
     * Remove 大明 — the first member the owner can act on. The confirm click is
     * wrapped in `act` so the whole chain it starts (removal → report to this
     * page → member/bookshelf refresh) has settled before the caller asserts.
     */
    async function removeDaMing() {
      fireEvent.click(screen.getAllByRole("button", { name: "移除" })[0]);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "確定" }));
      });
    }

    it("does not offer the entry before anything was removed", async () => {
      await renderSettled();

      expect(screen.getByText("大明")).toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });

    it("offers to lift the rejoin block, naming the member just removed", async () => {
      await renderSettled();

      await removeDaMing();

      expect(mockRemoveMember).toHaveBeenCalledWith(
        defaultProps.familyId,
        REMOVED_ID,
      );
      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();
    });

    it("lifts the block for the removed member when the entry is used", async () => {
      await renderSettled();
      await removeDaMing();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "解除移除限制" }));
      });

      expect(mockUnkickMember).toHaveBeenCalledWith(
        defaultProps.familyId,
        REMOVED_ID,
      );
      expect(
        screen.getByText(buildUnkickedNoticeText("大明")),
      ).toBeInTheDocument();
    });

    /**
     * 解除限制後對方可以重新加入，也可能再被移除一次——這時後端寫了一個新的
     * tombstone，通知卡必須回到 idle 把「解除移除限制」入口交還給管理者。若卡片
     * 停在上一次的成功文案，管理者會以為第二次的限制也已經解除。
     */
    it("returns the entry to idle when the same member is removed again", async () => {
      // The refreshed list still holds 大明 (see this describe's beforeEach) —
      // standing in for them rejoining once the first block was lifted.
      const clock = controlClock(1_700_000_000_000);
      await renderSettled();

      await removeDaMing();
      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "解除移除限制" }));
      });
      expect(
        screen.getByText(buildUnkickedNoticeText("大明")),
      ).toBeInTheDocument();

      // 大明 rejoined; a minute later the owner removes them a second time.
      clock.advance(60_000);
      await removeDaMing();

      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(buildUnkickedNoticeText("大明")),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "解除移除限制" }),
      ).toBeEnabled();
      // Only the FIRST block was lifted — the new one still stands.
      expect(mockUnkickMember).toHaveBeenCalledTimes(1);
    });

    /**
     * The reason the state lives on this page: the removal — and the block it
     * wrote — already happened, so a member refresh failing afterwards must not
     * take the only way to undo it down with the list.
     */
    it("keeps the entry when the member-list refresh fails afterwards", async () => {
      mockGetFamilyMembers.mockReset();
      mockGetFamilyMembers
        .mockResolvedValueOnce(membersResponse(SELF_ID))
        .mockResolvedValue({
          error: { code: "SERVER_ERROR", message: "載入成員失敗" },
        });
      await renderSettled();

      await removeDaMing();

      // The list itself is gone (error state) — 阿華 only ever renders there.
      expect(screen.getByText("載入成員失敗")).toBeInTheDocument();
      expect(screen.queryByText("阿華")).not.toBeInTheDocument();
      // ...but the entry to lift the block the removal wrote is still offered.
      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();
    });

    it("dismisses the entry when 關閉 is pressed", async () => {
      await renderSettled();
      await removeDaMing();
      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "關閉" }));

      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
      expect(mockUnkickMember).not.toHaveBeenCalled();
    });

    it("withdraws the entry when ownership moved away during the removal", async () => {
      mockGetFamilyMembers.mockReset();
      mockGetFamilyMembers
        .mockResolvedValueOnce(membersResponse(SELF_ID))
        // Ownership moved to 阿華 while the removal was in flight — only the
        // owner may lift the block, so the entry must not linger.
        .mockResolvedValue(membersResponse(THIRD_ID));
      await renderSettled();

      await removeDaMing();

      // The refresh landed, so a still-owner would be showing 移除 again here.
      expect(mockGetFamilyMembers).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "移除" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });

    it("does not offer the entry to a non-owner member", async () => {
      mockGetFamilyMembers.mockResolvedValue(membersResponse(THIRD_ID));
      await renderSettled();

      expect(screen.getByText("大明")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "移除" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });

    it("does not offer the entry when the removal itself failed", async () => {
      mockRemoveMember.mockResolvedValue({
        error: { code: "FORBIDDEN", message: "權限不足" },
      });
      await renderSettled();

      await removeDaMing();

      expect(screen.getByText("權限不足")).toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
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

  // --- Rate-limited writes ---

  /**
   * The Worker rate-limits the family write endpoints (429 RATE_LIMITED, with
   * an optional `retryAfter`). Its `message` is English, so both write paths
   * here render the localized back-off copy instead — asserted against the
   * production builder, whose literals are pinned in
   * pwa/tests/unit/retryMessage.test.ts.
   */
  it("shows the localized back-off copy when leave family is rate limited", async () => {
    mockLeaveFamily.mockResolvedValue({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        retryAfter: 90,
      },
    });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));

    await waitFor(() => {
      expect(
        screen.getByText(buildRetryMessage("RATE_LIMITED", 90)),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Too many requests")).not.toBeInTheDocument();
    // A refused leave must not look like it succeeded.
    expect(defaultProps.onLogout).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "離開家庭" }),
    ).toBeInTheDocument();
  });

  it("shows the localized back-off copy when the display name save is rate limited", async () => {
    mockUpdateDisplayName.mockResolvedValue({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        retryAfter: 45,
      },
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
    fireEvent.change(screen.getByRole("textbox", { name: "顯示名稱" }), {
      target: { value: "Bob" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(
        screen.getByText(buildRetryMessage("RATE_LIMITED", 45)),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Too many requests")).not.toBeInTheDocument();
  });

  it("shows the static back-off copy when the 429 carried no retryAfter", async () => {
    mockLeaveFamily.mockResolvedValue({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    fireEvent.click(screen.getByRole("button", { name: "確定離開" }));

    await waitFor(() => {
      expect(
        screen.getByText(buildRetryMessage("RATE_LIMITED", 0)),
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

  it("pushes the trimmed name into the family context after a successful save", async () => {
    mockUpdateDisplayName.mockResolvedValue({ data: { ok: true } });
    // Mount load returns "Alice"; the post-save reload is left pending so it
    // cannot clobber the optimistic context update. Any change the probe shows
    // therefore comes from `updateMemberDisplayName`, not the reload.
    mockGetFamilyMembers.mockReset();
    mockGetFamilyMembers
      .mockResolvedValueOnce({
        data: {
          members: [{ userId: defaultProps.userId, displayName: "Alice" }],
          ownerId: defaultProps.userId,
        },
      })
      .mockReturnValue(new Promise(() => {}));

    renderWithProbe();

    const probe = () => screen.getByTestId("members-probe");
    await waitFor(() => {
      expect(within(probe()).getByText("Alice")).toBeInTheDocument();
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

    // Context now reflects the new name (direct call replaces the CustomEvent).
    await waitFor(() => {
      expect(within(probe()).getByText("新名字")).toBeInTheDocument();
    });
    expect(within(probe()).queryByText("Alice")).not.toBeInTheDocument();
  });

  it("does not touch the family context when the display name update fails", async () => {
    mockUpdateDisplayName.mockResolvedValue({
      error: { code: "INVALID", message: "名稱格式不正確" },
    });
    mockGetFamilyMembers.mockResolvedValue({
      data: {
        members: [{ userId: defaultProps.userId, displayName: "Alice" }],
        ownerId: defaultProps.userId,
      },
    });

    renderWithProbe();

    const probe = () => screen.getByTestId("members-probe");
    await waitFor(() => {
      expect(within(probe()).getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    const input = screen.getByRole("textbox", { name: "顯示名稱" });
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "確認修改名稱" }));

    await waitFor(() => {
      expect(screen.getByText("名稱格式不正確")).toBeInTheDocument();
    });

    // Failed save must leave the shared context untouched.
    expect(within(probe()).getByText("Alice")).toBeInTheDocument();
    expect(within(probe()).queryByText("新名字")).not.toBeInTheDocument();
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
      expect(
        screen.getByRole("button", { name: "編輯顯示名稱" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "編輯顯示名稱" }));
    // Input should be visible
    expect(
      screen.getByRole("textbox", { name: "顯示名稱" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消修改名稱" }));

    // Should return to display mode — input gone
    expect(
      screen.queryByRole("textbox", { name: "顯示名稱" }),
    ).not.toBeInTheDocument();
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
    expect(
      localStorage.getItem(`moo:${defaultProps.userId}:syncArchived`),
    ).toBe("1");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      localStorage.getItem(`moo:${defaultProps.userId}:syncArchived`),
    ).toBe("0");
  });

  // --- Version & disclaimer ---

  it("shows version and third-party disclaimer", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(screen.getByText(/墨家書櫃 v/)).toBeInTheDocument();
    expect(
      screen.getByText("本程式為第三方開發，非 Readmoo 讀墨官方提供。"),
    ).toBeInTheDocument();
  });

  // --- Leave family cancel ---

  it("cancel leave family returns to idle state", async () => {
    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "離開家庭" }));
    expect(
      screen.getByRole("button", { name: "確定離開" }),
    ).toBeInTheDocument();

    // Click cancel in the leave section
    const cancelButtons = screen.getAllByRole("button", { name: "取消" });
    // Leave cancel is the first 取消 button
    fireEvent.click(cancelButtons[0]);

    expect(
      screen.getByRole("button", { name: "離開家庭" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "確定離開" }),
    ).not.toBeInTheDocument();
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

  it("should show @host suffix in sync code when custom API is used", async () => {
    mockEncodeSyncCode.mockReturnValue("moo-fam1-key1@custom.api.com");

    renderWithMembers([defaultProps.userId], defaultProps.userId);

    await waitFor(() => {
      expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
    });

    expect(
      screen.getByText("moo-fam1-key1@custom.api.com"),
    ).toBeInTheDocument();

    // Restore default mock
    mockEncodeSyncCode.mockReturnValue("moo-fam1-key1");
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
