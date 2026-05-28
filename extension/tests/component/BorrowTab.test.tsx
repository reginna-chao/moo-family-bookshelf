import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";

// Stub the Readmoo automation so 同意借閱 can succeed in jsdom (no real Readmoo DOM).
const mockOpenLendDialogForBook = vi.fn();
const mockSelectMemberByName = vi.fn();
const mockWaitForLendDialogClose = vi.fn().mockResolvedValue(true);
const mockCloseLendDialog = vi.fn();
vi.mock("@/content/readmoo-lend", async () => {
  // Pull in the real `decideLendAction` so picker / fast-match branching is
  // exercised exactly as in production. Only the side-effecting helpers are
  // stubbed because jsdom does not contain the Readmoo DOM.
  const actual = await vi.importActual<typeof import("@/content/readmoo-lend")>(
    "@/content/readmoo-lend",
  );
  return {
    ...actual,
    ReadmooLendError: class ReadmooLendError extends Error {
      constructor(public code: string, message: string) { super(message); }
    },
    openLendDialogForBook: (...args: unknown[]) => mockOpenLendDialogForBook(...args),
    selectMemberByName: (...args: unknown[]) => mockSelectMemberByName(...args),
    waitForLendDialogClose: (...args: unknown[]) => mockWaitForLendDialogClose(...args),
    closeLendDialog: (...args: unknown[]) => mockCloseLendDialog(...args),
  };
});

import { BorrowTab } from "@/dialog/BorrowTab";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import {
  BoolFlag,
  type ApiClient,
  type BorrowRequest,
  BorrowStatus,
} from "@/api/client";

const OWNER_ID = "user-owner123";
const BORROWER_ID = "user-borrower456";

function makeRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    requestId: "req-1",
    familyId: "fam-1",
    borrowerId: BORROWER_ID,
    borrowerName: "Alice",
    ownerId: OWNER_ID,
    bookId: "book-1",
    bookTitle: "測試書",
    bookAuthor: "測試作者",
    bookCoverUrl: "https://example.com/cover.jpg",
    status: BorrowStatus.PENDING,
    createdAt: "2026-04-25T10:00:00.000Z",
    updatedAt: "2026-04-25T10:00:00.000Z",
    ...overrides,
  };
}

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-1",
        ownerId: OWNER_ID,
        members: [
          { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE, readmooName: "Owner" },
          { userId: BORROWER_ID, displayName: "Alice", canLend: BoolFlag.TRUE, readmooName: "Alice" },
        ],
      },
    }),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-1", members: [] } }),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    updateBorrowStatus: vi.fn().mockResolvedValue(makeRequest()),
    ...overrides,
  } as unknown as ApiClient;
}

function renderBorrowTab(
  apiClient: ApiClient,
  { userId = OWNER_ID, familyId = "fam-1" }: { userId?: string; familyId?: string } = {},
) {
  return render(
    <FamilyDataProvider familyId={familyId} userId={userId} apiClient={apiClient}>
      <BorrowTab userId={userId} apiClient={apiClient} />
    </FamilyDataProvider>,
  );
}

describe("BorrowTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: readmoo-lend automation succeeds (returns a fake lend dialog).
    mockOpenLendDialogForBook.mockResolvedValue({
      lendDialog: document.createElement("div"),
      detailModal: document.createElement("div"),
      members: [{ name: "Alice", avatar: "" }],
    });
    // selectMemberByName now returns boolean: true=found+clicked, false=not found.
    mockSelectMemberByName.mockReturnValue(true);
    mockWaitForLendDialogClose.mockResolvedValue(true);
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("shows loading state initially", () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockReturnValue(new Promise(() => {})),
    });

    renderBorrowTab(apiClient);

    expect(screen.getByText("載入借閱資料中...")).toBeInTheDocument();
  });

  it("shows empty state when there are no requests", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockResolvedValue([]),
    });

    renderBorrowTab(apiClient);

    await waitFor(() => {
      // Both incoming + outgoing sections show the empty message
      expect(screen.getAllByText("尚無借閱請求")).toHaveLength(2);
    });
    // Section titles should still be present
    expect(screen.getByText("收件匣")).toBeInTheDocument();
    expect(screen.getByText("寄件匣")).toBeInTheDocument();
  });

  it("renders incoming PENDING request with 同意借閱 + 拒絕 buttons", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("同意借閱")).toBeInTheDocument();
    });
    expect(screen.getByText("拒絕")).toBeInTheDocument();
    // Cancel button should not appear for incoming request
    expect(screen.queryByText("取消申請")).not.toBeInTheDocument();
  });

  it("renders outgoing PENDING request with 取消申請 button", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockResolvedValue([
        makeRequest({
          requestId: "req-out-1",
          status: BorrowStatus.PENDING,
        }),
      ]),
    });

    // Render as the borrower (current user) so it's outgoing
    renderBorrowTab(apiClient, { userId: BORROWER_ID });

    await waitFor(() => {
      expect(screen.getByText("取消申請")).toBeInTheDocument();
    });
    // Approve / reject buttons should NOT show for outgoing request
    expect(screen.queryByText("同意借閱")).not.toBeInTheDocument();
    expect(screen.queryByText("拒絕")).not.toBeInTheDocument();
  });

  it("renders LENT incoming request with 標記已歸還 button", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.LENT })]),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("標記已歸還")).toBeInTheDocument();
    });
    expect(screen.queryByText("同意借閱")).not.toBeInTheDocument();
    expect(screen.queryByText("拒絕")).not.toBeInTheDocument();
  });

  it("renders archived (RETURNED/REJECTED/CANCELLED) requests without action buttons", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockResolvedValue([
        makeRequest({
          requestId: "req-returned",
          status: BorrowStatus.RETURNED,
          bookTitle: "已歸還書",
        }),
        makeRequest({
          requestId: "req-rejected",
          status: BorrowStatus.REJECTED,
          bookTitle: "已拒絕書",
        }),
        makeRequest({
          requestId: "req-cancelled",
          status: BorrowStatus.CANCELLED,
          bookTitle: "已取消書",
        }),
      ]),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    // Archived items are hidden under a toggle; click to reveal then verify no action buttons
    await waitFor(() => {
      expect(screen.getByText("顯示歷史紀錄 (3)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("顯示歷史紀錄 (3)"));

    await waitFor(() => {
      expect(screen.getByText("已歸還書")).toBeInTheDocument();
    });
    expect(screen.getByText("已拒絕書")).toBeInTheDocument();
    expect(screen.getByText("已取消書")).toBeInTheDocument();
    // No action buttons for archived
    expect(screen.queryByText("同意借閱")).not.toBeInTheDocument();
    expect(screen.queryByText("拒絕")).not.toBeInTheDocument();
    expect(screen.queryByText("取消申請")).not.toBeInTheDocument();
    expect(screen.queryByText("標記已歸還")).not.toBeInTheDocument();
  });

  it("clicking 同意借閱 calls updateBorrowStatus with LENT", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValue(makeRequest({ status: BorrowStatus.LENT }));
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
      updateBorrowStatus,
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("同意借閱")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("同意借閱"));

    await waitFor(() => {
      expect(updateBorrowStatus).toHaveBeenCalledWith("req-1", BorrowStatus.LENT);
    });
  });

  it("clicking 拒絕 calls updateBorrowStatus with REJECTED", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValue(makeRequest({ status: BorrowStatus.REJECTED }));
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
      updateBorrowStatus,
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("拒絕")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("拒絕"));

    await waitFor(() => {
      expect(updateBorrowStatus).toHaveBeenCalledWith(
        "req-1",
        BorrowStatus.REJECTED,
      );
    });
  });

  it("clicking 取消申請 calls updateBorrowStatus with CANCELLED", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValue(makeRequest({ status: BorrowStatus.CANCELLED }));
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockResolvedValue([
        makeRequest({
          requestId: "req-out-1",
          status: BorrowStatus.PENDING,
        }),
      ]),
      updateBorrowStatus,
    });

    renderBorrowTab(apiClient, { userId: BORROWER_ID });

    await waitFor(() => {
      expect(screen.getByText("取消申請")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("取消申請"));

    await waitFor(() => {
      expect(updateBorrowStatus).toHaveBeenCalledWith(
        "req-out-1",
        BorrowStatus.CANCELLED,
      );
    });
  });

  it("clicking 標記已歸還 calls updateBorrowStatus with RETURNED", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValue(makeRequest({ status: BorrowStatus.RETURNED }));
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.LENT })]),
      updateBorrowStatus,
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("標記已歸還")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("標記已歸還"));

    await waitFor(() => {
      expect(updateBorrowStatus).toHaveBeenCalledWith(
        "req-1",
        BorrowStatus.RETURNED,
      );
    });
  });

  it("refreshes borrow requests after a successful action", async () => {
    const listBorrowRequests = vi
      .fn()
      .mockResolvedValueOnce([makeRequest({ status: BorrowStatus.PENDING })])
      .mockResolvedValueOnce([makeRequest({ status: BorrowStatus.LENT })]);
    const apiClient = createMockApiClient({
      listBorrowRequests,
      updateBorrowStatus: vi
        .fn()
        .mockResolvedValue(makeRequest({ status: BorrowStatus.LENT })),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("同意借閱")).toBeInTheDocument();
    });
    expect(listBorrowRequests).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("同意借閱"));

    await waitFor(() => {
      expect(listBorrowRequests).toHaveBeenCalledTimes(2);
    });
  });

  it("shows error message when updateBorrowStatus fails", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi
        .fn()
        .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
      updateBorrowStatus: vi.fn().mockRejectedValue(new Error("更新失敗了")),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("拒絕")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("拒絕"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("更新失敗了");
    });
  });

  it("shows error state with retry when listBorrowRequests fails", async () => {
    const apiClient = createMockApiClient({
      listBorrowRequests: vi.fn().mockRejectedValue(new Error("Network down")),
    });

    renderBorrowTab(apiClient, { userId: OWNER_ID });

    await waitFor(() => {
      expect(screen.getByText("Network down")).toBeInTheDocument();
      expect(screen.getByText("重試")).toBeInTheDocument();
    });
  });

  describe("approve lending flow — picker decision", () => {
    it("n=1: auto-single — does NOT PATCH readmooName and proceeds to LENT", async () => {
      const updateMemberSettings = vi.fn();
      const updateBorrowStatus = vi
        .fn()
        .mockResolvedValue(makeRequest({ status: BorrowStatus.LENT }));
      const apiClient = createMockApiClient({
        // Borrower has NO readmooName cached, but only one Readmoo option exists.
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            ownerId: OWNER_ID,
            members: [
              { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE },
              { userId: BORROWER_ID, displayName: "Alice", canLend: BoolFlag.TRUE },
            ],
          },
        }),
        listBorrowRequests: vi
          .fn()
          .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
        updateBorrowStatus,
        updateMemberSettings,
      });
      mockOpenLendDialogForBook.mockResolvedValue({
        lendDialog: document.createElement("div"),
        detailModal: document.createElement("div"),
        members: [{ name: "AliceOnly", avatar: "" }],
      });

      renderBorrowTab(apiClient, { userId: OWNER_ID });

      await waitFor(() => {
        expect(screen.getByText("同意借閱")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("同意借閱"));

      await waitFor(() => {
        expect(updateBorrowStatus).toHaveBeenCalledWith("req-1", BorrowStatus.LENT);
      });
      expect(updateMemberSettings).not.toHaveBeenCalled();
      expect(mockSelectMemberByName).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        "AliceOnly",
      );
    });

    it("n>=2 + readmooName match: auto-match — does NOT PATCH and proceeds to LENT", async () => {
      const updateMemberSettings = vi.fn();
      const updateBorrowStatus = vi
        .fn()
        .mockResolvedValue(makeRequest({ status: BorrowStatus.LENT }));
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            ownerId: OWNER_ID,
            members: [
              { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE },
              {
                userId: BORROWER_ID,
                displayName: "Alice",
                canLend: BoolFlag.TRUE,
                readmooName: "Alice",
              },
            ],
          },
        }),
        listBorrowRequests: vi
          .fn()
          .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
        updateBorrowStatus,
        updateMemberSettings,
      });
      mockOpenLendDialogForBook.mockResolvedValue({
        lendDialog: document.createElement("div"),
        detailModal: document.createElement("div"),
        members: [
          { name: "Alice", avatar: "" },
          { name: "Bob", avatar: "" },
        ],
      });

      renderBorrowTab(apiClient, { userId: OWNER_ID });

      await waitFor(() => {
        expect(screen.getByText("同意借閱")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("同意借閱"));

      await waitFor(() => {
        expect(updateBorrowStatus).toHaveBeenCalledWith("req-1", BorrowStatus.LENT);
      });
      expect(updateMemberSettings).not.toHaveBeenCalled();
      expect(mockSelectMemberByName).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        "Alice",
      );
    });

    it("n>=2 + no readmooName: shows picker, on pick → PATCH + LENT", async () => {
      const updateMemberSettings = vi.fn().mockResolvedValue({
        userId: BORROWER_ID,
        displayName: "Alice",
        canLend: BoolFlag.TRUE,
        readmooName: "Bob",
      });
      const updateBorrowStatus = vi
        .fn()
        .mockResolvedValue(makeRequest({ status: BorrowStatus.LENT }));
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            ownerId: OWNER_ID,
            members: [
              { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE },
              {
                userId: BORROWER_ID,
                displayName: "Alice",
                canLend: BoolFlag.TRUE,
              },
            ],
          },
        }),
        listBorrowRequests: vi
          .fn()
          .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
        updateBorrowStatus,
        updateMemberSettings,
      });
      mockOpenLendDialogForBook.mockResolvedValue({
        lendDialog: document.createElement("div"),
        detailModal: document.createElement("div"),
        members: [
          { name: "Alice", avatar: "" },
          { name: "Bob", avatar: "" },
        ],
      });

      renderBorrowTab(apiClient, { userId: OWNER_ID });

      await waitFor(() => {
        expect(screen.getByText("同意借閱")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("同意借閱"));

      // Picker appears
      await waitFor(() => {
        expect(
          screen.getByText(/請選擇「Alice」對應的讀墨家庭成員/),
        ).toBeInTheDocument();
      });

      // Pick Bob
      fireEvent.click(screen.getByRole("button", { name: /Bob/ }));

      await waitFor(() => {
        expect(updateMemberSettings).toHaveBeenCalledWith(
          "fam-1",
          BORROWER_ID,
          { readmooName: "Bob" },
        );
        expect(updateBorrowStatus).toHaveBeenCalledWith("req-1", BorrowStatus.LENT);
      });
    });

    it("n>=2 picker cancel: closes Readmoo dialog and keeps request PENDING", async () => {
      const updateMemberSettings = vi.fn();
      const updateBorrowStatus = vi.fn();
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            ownerId: OWNER_ID,
            members: [
              { userId: OWNER_ID, displayName: "Owner", canLend: BoolFlag.TRUE },
              {
                userId: BORROWER_ID,
                displayName: "Alice",
                canLend: BoolFlag.TRUE,
              },
            ],
          },
        }),
        listBorrowRequests: vi
          .fn()
          .mockResolvedValue([makeRequest({ status: BorrowStatus.PENDING })]),
        updateBorrowStatus,
        updateMemberSettings,
      });
      mockOpenLendDialogForBook.mockResolvedValue({
        lendDialog: document.createElement("div"),
        detailModal: document.createElement("div"),
        members: [
          { name: "Alice", avatar: "" },
          { name: "Bob", avatar: "" },
        ],
      });

      renderBorrowTab(apiClient, { userId: OWNER_ID });

      await waitFor(() => {
        expect(screen.getByText("同意借閱")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("同意借閱"));

      await waitFor(() => {
        expect(
          screen.getByText(/請選擇「Alice」對應的讀墨家庭成員/),
        ).toBeInTheDocument();
      });

      // Click 取消
      fireEvent.click(screen.getByRole("button", { name: "取消" }));

      await waitFor(() => {
        // Picker dismissed
        expect(
          screen.queryByText(/請選擇「Alice」對應的讀墨家庭成員/),
        ).not.toBeInTheDocument();
      });

      // No PATCH, no status change, Readmoo dialog closed
      expect(updateMemberSettings).not.toHaveBeenCalled();
      expect(updateBorrowStatus).not.toHaveBeenCalled();
      expect(mockCloseLendDialog).toHaveBeenCalledTimes(1);
    });
  });
});
