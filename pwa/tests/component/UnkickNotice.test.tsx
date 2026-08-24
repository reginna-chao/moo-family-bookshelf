import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
  UnkickNotice,
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "@/components/UnkickNotice";
import { BoolFlag, type ApiClient } from "@/api/client";

const FAMILY_ID = "fam-001";
const TARGET_ID =
  "aabbccdd11223344556677889900aabbccddeeff11223344556677889900aabb";
const DISPLAY_NAME = "小明";

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

type UnkickNoticeProps = ComponentProps<typeof UnkickNotice>;

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

  it("names the removed member and offers to lift the rejoin block", () => {
    renderNotice();

    expect(
      screen.getByText(buildRemovedNoticeText(DISPLAY_NAME)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除移除限制" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * The product distinction the copy must keep: lifting the block does NOT put
   * the member back in the family (Inv-4) — they still have to join with the
   * sync code themselves.
   */
  it("states that lifting the block does not re-add the member", () => {
    renderNotice();

    expect(screen.getByText(HINT_TEXT)).toBeInTheDocument();
  });

  /**
   * Covers both states in one pass because the wording, not the flow, is what
   * is being fixed here — the flow itself is covered by the tests below.
   */
  it("pins the exact removed / cleared copy against the render site", async () => {
    renderNotice();

    expect(screen.getByText(REMOVED_TEXT)).toBeInTheDocument();

    await act(async () => {
      clickUnkick();
    });

    expect(screen.getByText(UNKICKED_TEXT)).toBeInTheDocument();
  });

  it("calls unkickMember with the family and the removed member, then reports the block as lifted", async () => {
    const apiClient = createMockApiClient();
    renderNotice({ apiClient });

    await act(async () => {
      clickUnkick();
    });

    expect(apiClient.unkickMember).toHaveBeenCalledWith(FAMILY_ID, TARGET_ID);
    expect(
      screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(buildRemovedNoticeText(DISPLAY_NAME)),
    ).not.toBeInTheDocument();
  });

  /**
   * The endpoint is idempotent — an already-expired tombstone answers 200 with
   * `cleared: FALSE`. The user-visible outcome is identical (nothing is blocking
   * the rejoin any more), so the UI must not branch on the flag and re-open the
   * entry as if the request had failed.
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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "解除移除限制" }),
    ).not.toBeInTheDocument();
  });

  it("dismisses from the success state without a further request", async () => {
    const apiClient = createMockApiClient();
    const onDismiss = vi.fn();
    renderNotice({ apiClient, onDismiss });

    await act(async () => {
      clickUnkick();
    });
    fireEvent.click(screen.getByRole("button", { name: "關閉" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Dismissing is purely local — the block was already lifted above, so the
    // 關閉 in the success state must not re-issue the request.
    expect(apiClient.unkickMember).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while the request is in flight", async () => {
    let resolveUnkick!: (value: { data: { cleared: BoolFlag } }) => void;
    const pending = new Promise<{ data: { cleared: BoolFlag } }>((resolve) => {
      resolveUnkick = resolve;
    });
    const apiClient = createMockApiClient({
      unkickMember: vi.fn().mockReturnValue(pending),
    });
    renderNotice({ apiClient });

    clickUnkick();

    expect(screen.getByRole("button", { name: "解除中..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "關閉" })).toBeDisabled();

    // Settle the request so no state update escapes the test.
    await act(async () => {
      resolveUnkick({ data: { cleared: BoolFlag.TRUE } });
    });
    expect(
      screen.getByText(buildUnkickedNoticeText(DISPLAY_NAME)),
    ).toBeInTheDocument();
  });

  it("surfaces a refused request as an alert and stays retryable", async () => {
    const apiClient = createMockApiClient({
      unkickMember: vi.fn().mockResolvedValue({
        error: { code: "NOT_OWNER", message: "只有管理者可以操作" },
      }),
    });
    renderNotice({ apiClient });

    await act(async () => {
      clickUnkick();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("只有管理者可以操作");
    expect(
      screen.getByText(buildRemovedNoticeText(DISPLAY_NAME)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除移除限制" })).toBeEnabled();
  });

  it("falls back to a generic message when the failure is not an Error", async () => {
    const apiClient = createMockApiClient({
      unkickMember: vi.fn().mockRejectedValue("boom"),
    });
    renderNotice({ apiClient });

    await act(async () => {
      clickUnkick();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("操作失敗");
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
