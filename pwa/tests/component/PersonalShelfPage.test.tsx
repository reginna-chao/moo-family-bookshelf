import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { PersonalShelfPage } from "@/pages/PersonalShelfPage";

import { BoolFlag, type PersonalBooks, type ApiClient } from "@/api/client";

// PersonalShelfPage now pulls `refreshBookshelf` from the FamilyData context to
// refresh the aggregated family shelf after a save (replaces the removed
// `personalShelfSaved` window CustomEvent). Mock the context hook to isolate the
// page and spy on the direct call — mirrors BorrowPage.test.tsx's approach.
const mockRefreshBookshelf = vi.fn(async () => {});
vi.mock("@/hooks/useFamilyData", () => ({
  useFamilyData: () => ({ refreshBookshelf: mockRefreshBookshelf }),
}));

const mockGetPersonalBooks = vi.fn();
const mockUpdatePersonalBooks = vi.fn();
const mockPatchPersonalBooks = vi.fn();

const mockApiClient = {
  getPersonalBooks: mockGetPersonalBooks,
  updatePersonalBooks: mockUpdatePersonalBooks,
  patchPersonalBooks: mockPatchPersonalBooks,
} as unknown as ApiClient;

function makePersonalBooks(
  displayName: string,
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    isShared: BoolFlag;
  }>,
): PersonalBooks {
  return {
    schemaVersion: 1,
    userId: "user-1",
    displayName,
    books: books.map((b) => ({
      bookId: b.bookId,
      title: b.title,
      author: b.author,
      isbn: "",
      coverUrl: "",
      readmooUrl: `https://readmoo.com/${b.bookId}`,
      category: "",
      isShared: b.isShared,
    })),
    lastUpdated: new Date().toISOString(),
  };
}

function createProps() {
  return {
    userId: "user-1",
    apiClient: mockApiClient,
  };
}

async function renderWithBooks(
  books: Array<{ bookId: string; title: string; author: string; isShared: BoolFlag }>,
  displayName = "TestUser",
) {
  mockGetPersonalBooks.mockResolvedValue({
    data: makePersonalBooks(displayName, books),
  });
  render(<PersonalShelfPage {...createProps()} />);
  await waitFor(() => {
    expect(screen.getByText(books[0].title)).toBeInTheDocument();
  });
}

describe("PersonalShelfPage", () => {
  let defaultProps: ReturnType<typeof createProps>;

  beforeEach(() => {
    mockGetPersonalBooks.mockReset();
    mockUpdatePersonalBooks.mockReset();
    mockPatchPersonalBooks.mockReset();
    mockPatchPersonalBooks.mockResolvedValue({ data: { ok: true, applied: 1 } });
    mockRefreshBookshelf.mockClear();
    defaultProps = createProps();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockGetPersonalBooks.mockReturnValue(new Promise(() => {})); // never resolves
    render(<PersonalShelfPage {...defaultProps} />);

    expect(screen.getByText("載入個人書櫃中...")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows error message and retry button when API fails", async () => {
    mockGetPersonalBooks.mockRejectedValue(new Error("Network error"));
    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText("重試")).toBeInTheDocument();
  });

  it("shows error when API returns error response", async () => {
    mockGetPersonalBooks.mockResolvedValue({
      error: { code: "NOT_FOUND", message: "找不到使用者資料" },
    });
    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("找不到使用者資料")).toBeInTheDocument();
    });
  });

  it("clicking retry button re-fetches data", async () => {
    mockGetPersonalBooks.mockRejectedValueOnce(new Error("Network error"));
    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("重試")).toBeInTheDocument();
    });

    // Set up success response for retry
    mockGetPersonalBooks.mockResolvedValue({
      data: makePersonalBooks("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      ]),
    });

    fireEvent.click(screen.getByText("重試"));

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });
    expect(mockGetPersonalBooks).toHaveBeenCalledTimes(2);
  });

  it("shows empty state when books array is empty", async () => {
    mockGetPersonalBooks.mockResolvedValue({
      data: makePersonalBooks("TestUser", []),
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("尚無已同步的書籍")).toBeInTheDocument();
    });
  });

  it("shows empty state when payload is missing", async () => {
    mockGetPersonalBooks.mockResolvedValue({
      data: {},
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("尚無已同步的書籍")).toBeInTheDocument();
    });
  });

  it("renders books with titles, authors, and share status badges", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    expect(screen.getByText("作者A")).toBeInTheDocument();
    expect(screen.getByText("書籍二")).toBeInTheDocument();
    expect(screen.getByText("作者B")).toBeInTheDocument();
    // Share status badges (read-only spans, not buttons)
    expect(screen.getByText("開放")).toBeInTheDocument();
    // "未開放" appears on filter button and badge
    const allUnshared = screen.getAllByText("未開放");
    expect(allUnshared.length).toBeGreaterThanOrEqual(2);
  });

  it("shows total book count in header", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    expect(screen.getByText("(2 本)")).toBeInTheDocument();
  });

  it("shows checkboxes for each book", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    expect(screen.getByLabelText("選取 書籍一")).toBeInTheDocument();
    expect(screen.getByLabelText("選取 書籍二")).toBeInTheDocument();
  });

  it("selecting a book shows floating action bar with count", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    // No toolbar initially
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("選取 書籍一"));

    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(screen.getByText("已選 1 本")).toBeInTheDocument();
    expect(screen.getByText("設為開放")).toBeInTheDocument();
    expect(screen.getByText("設為隱藏")).toBeInTheDocument();
  });

  it("batch share sets selected books to shared", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByLabelText("選取 書籍二"));
    expect(screen.getByText("已選 2 本")).toBeInTheDocument();

    fireEvent.click(screen.getByText("設為開放"));

    // Both badges should now show "開放"
    const sharedBadges = screen.getAllByText("開放");
    expect(sharedBadges.length).toBe(2);
    // Selection should be cleared
    expect(screen.queryByText("已選")).not.toBeInTheDocument();
    // Should be dirty — show save button
    expect(screen.getByText("儲存變更")).toBeInTheDocument();
  });

  it("batch hide sets selected books to not shared", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.TRUE },
    ]);

    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為隱藏"));

    // 書籍一 badge should now show "未開放"
    // Filter button "未開放" + book badge "未開放" for 書籍一
    const unsharedTexts = screen.getAllByText("未開放");
    expect(unsharedTexts.length).toBeGreaterThanOrEqual(2);
  });

  it("select all / deselect all toggles all visible books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    fireEvent.click(screen.getByText("全選"));
    expect(screen.getByText("已選 2 本")).toBeInTheDocument();
    expect(screen.getByText("取消全選")).toBeInTheDocument();

    fireEvent.click(screen.getByText("取消全選"));
    expect(screen.queryByText("已選")).not.toBeInTheDocument();
    expect(screen.getByText("全選")).toBeInTheDocument();
  });

  it("cancel changes restores original books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    // Batch share to make dirty
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));

    // Now dirty, badge shows "開放"
    expect(screen.getByText("開放")).toBeInTheDocument();
    expect(screen.getByText("取消變更")).toBeInTheDocument();

    fireEvent.click(screen.getByText("取消變更"));

    // Should restore to original state — badge back to "未開放"
    // "未開放" appears as filter button + badge
    const unsharedTexts = screen.getAllByText("未開放");
    expect(unsharedTexts.length).toBeGreaterThanOrEqual(2);
    // Floating bar should be hidden (no selection, not dirty)
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("save flow PATCHes only the changed (server-known) book", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    mockPatchPersonalBooks.mockResolvedValue({ data: { ok: true, applied: 1 } });

    // Batch share to make dirty
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));

    // Click save in floating bar
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(mockPatchPersonalBooks).toHaveBeenCalledWith("user-1", [
        { bookId: "b1", isShared: BoolFlag.TRUE },
      ]);
    });
    // Books loaded from the server are all server-known → PATCH, never PUT.
    expect(mockUpdatePersonalBooks).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("refreshes the family bookshelf via context after a successful PATCH save", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    mockPatchPersonalBooks.mockResolvedValue({ data: { ok: true, applied: 1 } });

    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));
    fireEvent.click(screen.getByText("儲存變更"));

    // The removed `personalShelfSaved` CustomEvent is now a direct context call:
    // saving the personal shelf re-fetches the aggregated family bookshelf.
    await waitFor(() => {
      expect(mockRefreshBookshelf).toHaveBeenCalled();
    });
  });

  it("does not refresh the family bookshelf when the save fails", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    mockPatchPersonalBooks.mockRejectedValue(new Error("儲存失敗"));

    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    });
    expect(mockRefreshBookshelf).not.toHaveBeenCalled();
  });

  it("floating action bar hidden when not dirty and no selection", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
    ]);

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("book list container padding tracks floating bar visibility", async () => {
    // Guards against drift between PersonalShelfPage's `showFloatingBar` and
    // FloatingActionBar's internal visibility. If they desync, the last book
    // row gets obscured by the fixed toolbar on mobile (no Playwright catches this).
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    // The container with the conditional padding is tagged with a stable testid
    // so we don't have to walk the DOM tree (which would break on any wrapper change).
    const bookListContainer = (): HTMLElement =>
      screen.getByTestId("personal-shelf-list-container");

    // No selection, not dirty → no toolbar, no extra padding.
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(bookListContainer().className).toContain("p-4");
    expect(bookListContainer().className).not.toMatch(/pb-\[var\(/);

    // Selecting a book makes the toolbar appear; container must add padding.
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    expect(bookListContainer().className).toMatch(/pb-\[var\(--personal-shelf-bottom-clearance\)\]/);
  });

  it("status filter '已開放' shows only shared books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    expect(screen.getByText("書籍二")).toBeInTheDocument();

    fireEvent.click(screen.getByText("已開放"));

    expect(screen.getByText("書籍一")).toBeInTheDocument();
    expect(screen.queryByText("書籍二")).not.toBeInTheDocument();
  });

  it("status filter '未開放' shows only unshared books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    // Click "未開放" filter button (first match)
    const filterButtons = screen.getAllByText("未開放");
    fireEvent.click(filterButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("書籍二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書籍一")).not.toBeInTheDocument();
  });

  it("'全部' filter shows all books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: BoolFlag.FALSE },
    ]);

    // Filter to "已開放" first
    fireEvent.click(screen.getByText("已開放"));
    expect(screen.queryByText("書籍二")).not.toBeInTheDocument();

    // Switch back to "全部"
    fireEvent.click(screen.getByText("全部"));
    expect(screen.getByText("書籍一")).toBeInTheDocument();
    expect(screen.getByText("書籍二")).toBeInTheDocument();
  });

  it("search filters books by title", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "React 入門", author: "作者A", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "Vue 入門", author: "作者B", isShared: BoolFlag.TRUE },
    ]);

    expect(screen.getByText("Vue 入門")).toBeInTheDocument();

    vi.useFakeTimers();

    fireEvent.change(screen.getByPlaceholderText("搜尋書名或作者"), {
      target: { value: "React" },
    });

    // Before debounce, both books still visible
    expect(screen.getByText("Vue 入門")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("React 入門")).toBeInTheDocument();
    expect(screen.queryByText("Vue 入門")).not.toBeInTheDocument();
  });

  it("search filters books by author", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "張三", isShared: BoolFlag.TRUE },
      { bookId: "b2", title: "書籍二", author: "李四", isShared: BoolFlag.FALSE },
    ]);

    vi.useFakeTimers();

    fireEvent.change(screen.getByPlaceholderText("搜尋書名或作者"), {
      target: { value: "李四" },
    });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("書籍二")).toBeInTheDocument();
    expect(screen.queryByText("書籍一")).not.toBeInTheDocument();
  });

  it("shows save error when the save request fails", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: BoolFlag.FALSE },
    ]);

    // Server-known book → save goes through PATCH; make it reject.
    mockPatchPersonalBooks.mockRejectedValue(new Error("儲存失敗"));

    // Batch share to make dirty
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    });
  });

  describe("Load More (Wave G)", () => {
    function makeManyBooks(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        bookId: `b${i + 1}`,
        title: `書籍 ${i + 1}`,
        author: `作者${i + 1}`,
        isShared: BoolFlag.FALSE,
      }));
    }

    it("shows Load More button when books exceed pageSize", async () => {
      await renderWithBooks(makeManyBooks(250));

      expect(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
      ).toBeInTheDocument();
    });

    it("does not show Load More button when books fit in pageSize", async () => {
      await renderWithBooks(makeManyBooks(80));

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });

    it("click Load More appends pageSize to visible count", async () => {
      await renderWithBooks(makeManyBooks(250));

      fireEvent.click(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 200.*共 250 本/ }),
        ).toBeInTheDocument();
      });
    });

    it("hides Load More button when status filter narrows the view", async () => {
      await renderWithBooks(makeManyBooks(250));

      fireEvent.click(screen.getByRole("button", { name: "已開放" }));

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });
  });
});
