import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  UnkickNotice,
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
  type UnkickNoticeProps,
} from "@/dialog/UnkickNotice";
import { BoolFlag, type ApiClient } from "@/api/client";

const FAMILY_ID = "fam-123";
const TARGET_ID = "user-def67890";
const DISPLAY_NAME = "大明";

/**
 * Pinned copy of the production hint literal (not exported by the component).
 * The assertion below renders the real component, so this string is compared
 * against the production render site — if the source copy changes, the test
 * fails rather than drifting.
 * Source: shared/src/unkick/messages.ts (UNKICK_HINT_TEXT)
 */
const HINT_TEXT = "解除後對方仍需自行輸入同步碼加入，不會自動回到家庭。";

/**
 * Pinned copies of the two notice literals. They are built by shared/, and every
 * other assertion in this file compares the builder output against itself, so a
 * reword would go unnoticed. These are asserted against the real render site.
 * Source: shared/src/unkick/messages.ts (buildRemovedNoticeText / buildUnkickedNoticeText)
 */
const REMOVED_TEXT = `已移除 ${DISPLAY_NAME}。若為誤移除，可解除限制讓對方重新加入。`;
const UNKICKED_TEXT = `已解除限制，${DISPLAY_NAME} 可重新使用同步碼加入（可能需要約一分鐘生效）`;

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    unkickMember: vi
      .fn()
      .mockResolvedValue({ data: { cleared: BoolFlag.TRUE } }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderNotice(props: Partial<UnkickNoticeProps> = {}) {
  const defaultProps: UnkickNoticeProps = {
    familyId: FAMILY_ID,
    targetUserId: TARGET_ID,
    displayName: DISPLAY_NAME,
    apiClient: createMockApiClient(),
    onDismiss: vi.fn(),
  };
  return render(<UnkickNotice {...defaultProps} {...props} />);
}

function clickUnkick() {
  fireEvent.click(screen.getByRole("button", { name: "解除移除限制" }));
}

describe("UnkickNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Covers both states in one pass because the wording, not the flow, is what
   * is being fixed here — the flow itself is covered by the suites below.
   */
  it("pins the exact removed / cleared copy against the render site", async () => {
    renderNotice();

    expect(screen.getByText(REMOVED_TEXT)).toBeInTheDocument();

    await act(async () => {
      clickUnkick();
    });

    expect(screen.getByText(UNKICKED_TEXT)).toBeInTheDocument();
  });

  describe("idle state", () => {
    it("names the removed member and offers to lift the rejoin block", () => {
      renderNotice();

      expect(
        screen.getByText(buildRemovedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "解除移除限制" }),
      ).toBeEnabled();
    });

    /**
     * The product distinction the copy must keep: lifting the block does NOT
     * put the member back in the family (Inv-4) — they still have to join with
     * the sync code themselves.
     */
    it("states that lifting the block does not re-add the member", () => {
      renderNotice();

      expect(screen.getByText(HINT_TEXT)).toBeInTheDocument();
    });

    it("shows no error before anything has been attempted", () => {
      renderNotice();

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("dismisses without calling the API when 關閉 is pressed", () => {
      const apiClient = createMockApiClient();
      const onDismiss = vi.fn();
      renderNotice({ apiClient, onDismiss });

      fireEvent.click(screen.getByRole("button", { name: "關閉" }));

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(apiClient.unkickMember).not.toHaveBeenCalled();
    });
  });

  describe("lifting the block", () => {
    it("calls unkickMember with the family and the removed member", async () => {
      const apiClient = createMockApiClient();
      renderNotice({ apiClient });

      await act(async () => {
        clickUnkick();
      });

      expect(apiClient.unkickMember).toHaveBeenCalledTimes(1);
      expect(apiClient.unkickMember).toHaveBeenCalledWith(FAMILY_ID, TARGET_ID);
    });

    it("disables both buttons while the request is in flight", async () => {
      let resolveUnkick!: (value: { data: { cleared: BoolFlag } }) => void;
      const pending = new Promise<{ data: { cleared: BoolFlag } }>(
        (resolve) => {
          resolveUnkick = resolve;
        },
      );
      const apiClient = createMockApiClient({
        unkickMember: vi.fn().mockReturnValue(pending),
      });
      renderNotice({ apiClient });

      clickUnkick();

      expect(screen.getByRole("button", { name: "解除中..." })).toBeDisabled();
      expect(screen.getByRole("button", { name: "關閉" })).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "解除移除限制" }),
      ).not.toBeInTheDocument();

      // Settle the request so no state update escapes the test.
      await act(async () => {
        resolveUnkick({ data: { cleared: BoolFlag.TRUE } });
      });
      expect(
        screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
    });

    it("reports the block as lifted and drops the removal copy on success", async () => {
      renderNotice();

      await act(async () => {
        clickUnkick();
      });

      expect(
        screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText(DISPLAY_NAME)),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "解除移除限制" }),
      ).not.toBeInTheDocument();
    });

    /**
     * The endpoint is idempotent — an already-expired tombstone answers 200 with
     * `cleared: FALSE`. The user-visible outcome is identical, so the UI must
     * not branch on the flag and re-open the entry.
     */
    it("treats an already-expired tombstone (cleared FALSE) as success", async () => {
      const apiClient = createMockApiClient({
        unkickMember: vi
          .fn()
          .mockResolvedValue({ data: { cleared: BoolFlag.FALSE } }),
      });
      renderNotice({ apiClient });

      await act(async () => {
        clickUnkick();
      });

      expect(
        screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
    });

    it("dismisses from the success state when 關閉 is pressed", async () => {
      const onDismiss = vi.fn();
      renderNotice({ onDismiss });

      await act(async () => {
        clickUnkick();
      });
      fireEvent.click(screen.getByRole("button", { name: "關閉" }));

      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe("failures", () => {
    it("surfaces a refused request as an alert and stays retryable", async () => {
      const apiClient = createMockApiClient({
        unkickMember: vi
          .fn()
          .mockResolvedValueOnce({
            error: { code: "NOT_OWNER", message: "只有管理者可以操作" },
          })
          .mockResolvedValueOnce({ data: { cleared: BoolFlag.TRUE } }),
      });
      renderNotice({ apiClient });

      await act(async () => {
        clickUnkick();
      });

      expect(screen.getByRole("alert")).toHaveTextContent("只有管理者可以操作");
      // Back to idle: the removal copy and an enabled button are still there.
      expect(
        screen.getByText(buildRemovedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "解除移除限制" }),
      ).toBeEnabled();

      await act(async () => {
        clickUnkick();
      });

      expect(apiClient.unkickMember).toHaveBeenCalledTimes(2);
      expect(
        screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("shows a thrown error's message", async () => {
      const apiClient = createMockApiClient({
        unkickMember: vi.fn().mockRejectedValue(new Error("Failed to fetch")),
      });
      renderNotice({ apiClient });

      await act(async () => {
        clickUnkick();
      });

      expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch");
      expect(
        screen.getByRole("button", { name: "解除移除限制" }),
      ).toBeEnabled();
    });

    it("falls back to a generic message when the failure is not an Error", async () => {
      const apiClient = createMockApiClient({
        unkickMember: vi.fn().mockRejectedValue("boom"),
      });
      renderNotice({ apiClient });

      await act(async () => {
        clickUnkick();
      });

      expect(screen.getByRole("alert")).toHaveTextContent("發生未知錯誤");
    });
  });
});
