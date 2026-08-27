import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BorrowPage } from "@/pages/BorrowPage";
import { namespacedKey } from "@/hooks/useAuth";
import {
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
  type FamilyMember,
} from "@/api/client";

// --- Mock useFamilyData hook ---

interface MockFamilyData {
  borrowRequests: BorrowRequest[];
  borrowRequestsState: "idle" | "loading" | "loaded" | "error";
  borrowRequestsError: string | null;
  refreshBorrowRequests: () => Promise<void>;
  applyBorrowStatus: (requestId: string, status: BorrowStatus) => void;
  members: FamilyMember[];
}

const mockRefreshBorrowRequests = vi.fn(async () => {});
const mockApplyBorrowStatus = vi.fn();
let mockFamilyData: MockFamilyData = {
  borrowRequests: [],
  borrowRequestsState: "loaded",
  borrowRequestsError: null,
  refreshBorrowRequests: mockRefreshBorrowRequests,
  applyBorrowStatus: mockApplyBorrowStatus,
  members: [],
};

vi.mock("@/hooks/useFamilyData", () => ({
  useFamilyData: () => mockFamilyData,
}));

// --- Mock ApiClient ---

const mockUpdateBorrowStatus = vi.fn();
const mockApiClient = {
  updateBorrowStatus: mockUpdateBorrowStatus,
} as unknown as ApiClient;

// --- Helpers ---

const SELF_USER_ID = "user-self";
const OTHER_USER_ID = "user-other";

function makeRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    requestId: "req-1",
    familyId: "fam-1",
    borrowerId: OTHER_USER_ID,
    borrowerName: "借閱者A",
    ownerId: SELF_USER_ID,
    bookId: "book-1",
    bookTitle: "測試書名",
    bookAuthor: "測試作者",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

function setMockFamilyData(partial: Partial<MockFamilyData>) {
  mockFamilyData = {
    borrowRequests: [],
    borrowRequestsState: "loaded",
    borrowRequestsError: null,
    refreshBorrowRequests: mockRefreshBorrowRequests,
    applyBorrowStatus: mockApplyBorrowStatus,
    members: [],
    ...partial,
  };
}

function renderPage() {
  return render(<BorrowPage userId={SELF_USER_ID} apiClient={mockApiClient} />);
}

describe("BorrowPage", () => {
  beforeEach(() => {
    mockRefreshBorrowRequests.mockClear();
    mockApplyBorrowStatus.mockClear();
    mockUpdateBorrowStatus.mockReset();
    setMockFamilyData({});
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state when borrowRequestsState is loading", () => {
    setMockFamilyData({ borrowRequestsState: "loading" });
    renderPage();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("載入借閱資料中...")).toBeInTheDocument();
  });

  it("shows empty state when there are no borrow requests", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [],
    });
    renderPage();

    // Both incoming (收件匣) and outgoing (寄件匣) sections show empty placeholder
    const empties = screen.getAllByText("尚無借閱請求");
    expect(empties.length).toBeGreaterThanOrEqual(2);
  });

  it("renders incoming PENDING request with borrower name, book title, 手動借出 and 拒絕 buttons", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-incoming-pending",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          borrowerName: "借閱者A",
          bookTitle: "測試書名",
          status: BorrowStatus.PENDING,
        }),
      ],
    });
    renderPage();

    expect(screen.getByText("測試書名")).toBeInTheDocument();
    expect(screen.getByText("借閱者A")).toBeInTheDocument();
    expect(screen.getByText("手動借出")).toBeInTheDocument();
    expect(screen.getByText("拒絕")).toBeInTheDocument();
    // PWA-specific: 同意借閱 (Extension automation) button must NOT be rendered
    expect(screen.queryByText("同意借閱")).not.toBeInTheDocument();
  });

  it("no longer shows the legacy 'approve in Extension' notice for incoming PENDING requests", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          status: BorrowStatus.PENDING,
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
        }),
      ],
    });
    renderPage();

    expect(
      screen.queryByText("請在桌面 Extension 中同意借閱"),
    ).not.toBeInTheDocument();
  });

  it("renders outgoing PENDING request with owner name and 取消申請 button", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-outgoing-pending",
          ownerId: OTHER_USER_ID,
          borrowerId: SELF_USER_ID,
          status: BorrowStatus.PENDING,
        }),
      ],
      members: [{ userId: OTHER_USER_ID, displayName: "持有者B" }],
    });
    renderPage();

    expect(screen.getByText("持有者B")).toBeInTheDocument();
    expect(screen.getByText("取消申請")).toBeInTheDocument();
    // No notice for outgoing
    expect(
      screen.queryByText("請在桌面 Extension 中同意借閱"),
    ).not.toBeInTheDocument();
  });

  it("renders LENT request in the history area with 標記已歸還 button (incoming side)", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-lent",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          status: BorrowStatus.LENT,
        }),
      ],
    });
    renderPage();

    // LENT is archived now: hidden until the history toggle is expanded.
    expect(screen.queryByText("標記已歸還")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("顯示歷史紀錄 (1)"));
    expect(screen.getByText("標記已歸還")).toBeInTheDocument();
  });

  it("renders archived (RETURNED/REJECTED/CANCELLED) requests without action buttons", () => {
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-returned",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          bookTitle: "已歸還書",
          status: BorrowStatus.RETURNED,
        }),
        makeRequest({
          requestId: "req-rejected",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          bookTitle: "已拒絕書",
          status: BorrowStatus.REJECTED,
        }),
        makeRequest({
          requestId: "req-cancelled",
          ownerId: OTHER_USER_ID,
          borrowerId: SELF_USER_ID,
          bookTitle: "已取消書",
          status: BorrowStatus.CANCELLED,
        }),
      ],
    });
    renderPage();

    // Archived requests are hidden behind a toggle; reveal them
    const incomingToggle = screen.getByText("顯示歷史紀錄 (2)");
    fireEvent.click(incomingToggle);
    const outgoingToggle = screen.getByText("顯示歷史紀錄 (1)");
    fireEvent.click(outgoingToggle);

    expect(screen.getByText("已歸還書")).toBeInTheDocument();
    expect(screen.getByText("已拒絕書")).toBeInTheDocument();
    expect(screen.getByText("已取消書")).toBeInTheDocument();
    // No action buttons for archived items
    expect(screen.queryByText("拒絕")).not.toBeInTheDocument();
    expect(screen.queryByText("取消申請")).not.toBeInTheDocument();
    expect(screen.queryByText("標記已歸還")).not.toBeInTheDocument();
  });

  /**
   * The borrow card renders its cover through `LazyCover`, so a cover that is
   * missing OR fails to load degrades to the same neutral placeholder instead
   * of leaving a broken-image box.
   *
   * The PWA runs TWO render-time beacon defences, not one:
   *   1. `safeCoverUrl` (pwa/src/utils/safeCoverUrl.ts) drops a cover outside
   *      the Readmoo host whitelist BEFORE it can become an `<img src>` — a
   *      code-level filter, so jsdom observes it and the cases below pin it.
   *   2. The CSP `img-src` in pwa/public/_headers (pinned by
   *      tests/unit/cspImgSrc.test.ts), which only a real browser enforces.
   * Layer 2 alone would not cover every deployment: `_headers` is honoured only
   * by hosts that serve it (Cloudflare Pages / Netlify), so `vite dev` /
   * `vite preview` and plain static hosts send no CSP at all and rely on
   * layer 1. Borrow records have no TTL, so covers stored before the Worker's
   * write-time check (INVALID_COVER_URL) still reach this render path.
   */
  describe("borrow card cover", () => {
    function renderWithCover(bookCoverUrl: string) {
      setMockFamilyData({
        borrowRequestsState: "loaded",
        borrowRequests: [
          makeRequest({
            requestId: "req-cover",
            ownerId: SELF_USER_ID,
            borrowerId: OTHER_USER_ID,
            status: BorrowStatus.PENDING,
            bookCoverUrl,
          }),
        ],
      });
      return renderPage();
    }

    it("renders the cover image when the request carries one", () => {
      renderWithCover("https://cdn.readmoo.com/cover/x.jpg");

      const img = screen.getByRole("img");
      expect(img).toHaveAttribute("src", "https://cdn.readmoo.com/cover/x.jpg");
      expect(img).toHaveAttribute("alt", "測試書名");
      expect(img).toHaveAttribute("loading", "lazy");
    });

    it("degrades to the placeholder when the cover image fails to load", () => {
      const { container } = renderWithCover(
        "https://cdn.readmoo.com/cover/gone.jpg",
      );

      fireEvent.error(screen.getByRole("img"));

      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      // The fallback is the same neutral box the empty-cover case renders.
      const placeholder = container.querySelector("div.bg-gray-100");
      expect(placeholder).not.toBeNull();
      // LazyCover 的 wrapper 也帶 bg-gray-100，多驗 relative 才能證明「wrapper 已消失、只剩 fallback」
      expect(placeholder).not.toHaveClass("relative");
      // The card itself must survive the failed cover.
      expect(screen.getByText("測試書名")).toBeInTheDocument();
    });

    it("renders no image at all when the request carries no cover URL", () => {
      const { container } = renderWithCover("");

      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      const placeholder = container.querySelector("div.bg-gray-100");
      expect(placeholder).not.toBeNull();
      // LazyCover 的 wrapper 也帶 bg-gray-100，多驗 relative 才能證明「wrapper 已消失、只剩 fallback」
      expect(placeholder).not.toHaveClass("relative");
      expect(screen.getByText("測試書名")).toBeInTheDocument();
    });

    it("drops a cover on a non-Readmoo host instead of requesting it", () => {
      const { container } = renderWithCover("https://evil.example/beacon.gif");

      // No `<img>` ⇒ the browser issues no request ⇒ no IP / UA leak. This is
      // the whole point of the filter, so assert on the element too, not only
      // on the accessible role.
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(container.querySelector("img")).toBeNull();
      // The beacon host must not survive anywhere in the markup (src, srcset,
      // a link, a data-* attribute...).
      expect(container.innerHTML).not.toContain("evil.example");

      const placeholder = container.querySelector("div.bg-gray-100");
      expect(placeholder).not.toBeNull();
      // LazyCover 的 wrapper 也帶 bg-gray-100，多驗 relative 才能證明「wrapper 已消失、只剩 fallback」
      expect(placeholder).not.toHaveClass("relative");
      // The card must still render — filtering a cover is not an error state.
      expect(screen.getByText("測試書名")).toBeInTheDocument();
      expect(screen.getByText("借閱者A")).toBeInTheDocument();
    });
  });

  it("clicking 拒絕 calls updateBorrowStatus with REJECTED", async () => {
    mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-1" });
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-1",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          status: BorrowStatus.PENDING,
        }),
      ],
    });
    renderPage();

    fireEvent.click(screen.getByText("拒絕"));

    await waitFor(() => {
      expect(mockUpdateBorrowStatus).toHaveBeenCalledWith(
        "req-1",
        BorrowStatus.REJECTED,
      );
    });
  });

  it("clicking 取消申請 calls updateBorrowStatus with CANCELLED", async () => {
    mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-2" });
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-2",
          ownerId: OTHER_USER_ID,
          borrowerId: SELF_USER_ID,
          status: BorrowStatus.PENDING,
        }),
      ],
    });
    renderPage();

    fireEvent.click(screen.getByText("取消申請"));

    await waitFor(() => {
      expect(mockUpdateBorrowStatus).toHaveBeenCalledWith(
        "req-2",
        BorrowStatus.CANCELLED,
      );
    });
  });

  it("clicking 標記已歸還 in the history area calls updateBorrowStatus with RETURNED", async () => {
    mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-3" });
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-3",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          status: BorrowStatus.LENT,
        }),
      ],
    });
    renderPage();

    // Reveal the LENT card from the collapsed history area first.
    fireEvent.click(screen.getByText("顯示歷史紀錄 (1)"));
    fireEvent.click(screen.getByText("標記已歸還"));

    await waitFor(() => {
      expect(mockUpdateBorrowStatus).toHaveBeenCalledWith(
        "req-3",
        BorrowStatus.RETURNED,
      );
    });
  });

  it("optimistically applies status locally after a successful update (no re-fetch)", async () => {
    mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-1" });
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-1",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          status: BorrowStatus.PENDING,
        }),
      ],
    });
    renderPage();

    fireEvent.click(screen.getByText("拒絕"));

    await waitFor(() => {
      expect(mockApplyBorrowStatus).toHaveBeenCalledWith(
        "req-1",
        BorrowStatus.REJECTED,
      );
    });
    // Optimistic update replaces the re-fetch entirely.
    expect(mockRefreshBorrowRequests).not.toHaveBeenCalled();
  });

  it("shows error state with retry button when borrowRequestsState is error", () => {
    setMockFamilyData({
      borrowRequestsState: "error",
      borrowRequestsError: "載入失敗",
    });
    renderPage();

    expect(screen.getByText("載入失敗")).toBeInTheDocument();
    const retryBtn = screen.getByText("重試");
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(mockRefreshBorrowRequests).toHaveBeenCalled();
  });

  it("shows action error message when updateBorrowStatus fails", async () => {
    mockUpdateBorrowStatus.mockRejectedValue(new Error("更新出錯"));
    setMockFamilyData({
      borrowRequestsState: "loaded",
      borrowRequests: [
        makeRequest({
          requestId: "req-fail",
          ownerId: SELF_USER_ID,
          borrowerId: OTHER_USER_ID,
          status: BorrowStatus.PENDING,
        }),
      ],
    });
    renderPage();

    fireEvent.click(screen.getByText("拒絕"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("更新出錯");
    });
    // On failure neither the optimistic apply nor a re-fetch may run.
    expect(mockApplyBorrowStatus).not.toHaveBeenCalled();
    expect(mockRefreshBorrowRequests).not.toHaveBeenCalled();
  });

  describe("手動借出 flow", () => {
    const MANUAL_LEND_KEY = namespacedKey(
      SELF_USER_ID,
      "manualLendNoticeDismissed",
    );

    function setIncomingPending(requestId = "req-manual") {
      setMockFamilyData({
        borrowRequestsState: "loaded",
        borrowRequests: [
          makeRequest({
            requestId,
            ownerId: SELF_USER_ID,
            borrowerId: OTHER_USER_ID,
            status: BorrowStatus.PENDING,
          }),
        ],
      });
    }

    it("opens the ManualLendDialog when the notice has not been dismissed", () => {
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));

      expect(screen.getByText("手動借出提醒")).toBeInTheDocument();
      // API must not be called just by opening the dialog
      expect(mockUpdateBorrowStatus).not.toHaveBeenCalled();
    });

    it("skips the dialog and calls updateBorrowStatus(LENT) when notice is dismissed", async () => {
      localStorage.setItem(MANUAL_LEND_KEY, "true");
      mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-manual" });
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));

      // No dialog appears
      expect(screen.queryByText("手動借出提醒")).not.toBeInTheDocument();
      await waitFor(() => {
        expect(mockUpdateBorrowStatus).toHaveBeenCalledWith(
          "req-manual",
          BorrowStatus.LENT,
        );
      });
    });

    it("calls updateBorrowStatus(LENT) when 確認借出 is clicked in the dialog", async () => {
      mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-manual" });
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));
      fireEvent.click(screen.getByText("確認借出"));

      await waitFor(() => {
        expect(mockUpdateBorrowStatus).toHaveBeenCalledWith(
          "req-manual",
          BorrowStatus.LENT,
        );
      });
    });

    it("does NOT call updateBorrowStatus when the dialog is cancelled", () => {
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));
      fireEvent.click(screen.getByText("取消"));

      expect(screen.queryByText("手動借出提醒")).not.toBeInTheDocument();
      expect(mockUpdateBorrowStatus).not.toHaveBeenCalled();
    });

    it("persists the dismissal flag when checkbox is checked before 確認借出", async () => {
      mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-manual" });
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByText("確認借出"));

      await waitFor(() => {
        expect(localStorage.getItem(MANUAL_LEND_KEY)).toBe("true");
      });
    });

    it("does NOT persist the flag when checkbox is left unchecked", async () => {
      mockUpdateBorrowStatus.mockResolvedValue({ requestId: "req-manual" });
      setIncomingPending();
      renderPage();

      fireEvent.click(screen.getByText("手動借出"));
      fireEvent.click(screen.getByText("確認借出"));

      await waitFor(() => {
        expect(mockUpdateBorrowStatus).toHaveBeenCalled();
      });
      expect(localStorage.getItem(MANUAL_LEND_KEY)).toBeNull();
    });
  });

  /**
   * `status` is bare-cast out of the API response by `listBorrowRequests()`,
   * and the API endpoint is user-configurable (BYO backend), so an out-of-enum
   * value can reach the badge. Anything that is not PENDING is archived, so the
   * card only mounts when the history toggle is expanded — that click is where
   * the old `getStatusStyle` (an exhaustive switch with no `default`) returned
   * `undefined` and threw, blanking the page.
   */
  describe("unknown status fallback", () => {
    it.each([
      { name: '"__proto__"', status: "__proto__" },
      { name: '"toString"', status: "toString" },
      { name: '"constructor"', status: "constructor" },
      { name: '"valueOf"', status: "valueOf" },
      { name: '"hasOwnProperty"', status: "hasOwnProperty" },
      { name: "an unknown numeric status (99)", status: 99 },
      // A backend that simply omits `status` is the likeliest out-of-range
      // case. `isActive` is `status === PENDING`, so these land in the
      // archived bucket exactly like the rows above.
      { name: "a null status", status: null },
      { name: "a missing status (undefined)", status: undefined },
    ])(
      "renders the unknown badge for $name instead of crashing",
      ({ status }) => {
        setMockFamilyData({
          borrowRequestsState: "loaded",
          borrowRequests: [
            makeRequest({
              requestId: "req-hostile",
              ownerId: SELF_USER_ID,
              borrowerId: OTHER_USER_ID,
              bookTitle: "未知狀態書",
              status: status as unknown as BorrowStatus,
            }),
          ],
        });

        expect(() => renderPage()).not.toThrow();
        // Non-PENDING ⇒ archived bucket, still collapsed at this point.
        expect(screen.queryByText("未知狀態書")).not.toBeInTheDocument();

        expect(() =>
          fireEvent.click(screen.getByText("顯示歷史紀錄 (1)")),
        ).not.toThrow();

        expect(screen.getByText("未知狀態書")).toBeInTheDocument();
        const badge = screen.getByText("狀態未知");
        expect(badge).toBeInTheDocument();
        expect(badge.className).not.toContain("undefined");
      },
    );
  });
});
