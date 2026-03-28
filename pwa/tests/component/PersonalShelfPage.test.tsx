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

// Mock crypto
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue("mock-key"),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));

import { decrypt, encrypt } from "@/crypto/encrypt";
import type { ApiClient } from "@/api/client";

const mockDecrypt = vi.mocked(decrypt);
const mockEncrypt = vi.mocked(encrypt);
const mockGetPersonalBooks = vi.fn();
const mockUpdatePersonalBooks = vi.fn();

const mockApiClient = {
  getPersonalBooks: mockGetPersonalBooks,
  updatePersonalBooks: mockUpdatePersonalBooks,
} as unknown as ApiClient;

function makePayload(
  displayName: string,
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    isShared: 0 | 1;
  }>,
): string {
  return JSON.stringify({
    displayName,
    books: books.map((b) => ({
      bookId: b.bookId,
      title: b.title,
      author: b.author,
      isbn: "",
      coverUrl: "",
      readmooUrl: `https://readmoo.com/${b.bookId}`,
      isShared: b.isShared,
    })),
  });
}

function createProps() {
  return {
    userId: "user-1",
    apiClient: mockApiClient,
    encryptionKey: "test-key",
  };
}

async function renderWithBooks(
  books: Array<{ bookId: string; title: string; author: string; isShared: 0 | 1 }>,
  displayName = "TestUser",
) {
  mockDecrypt.mockResolvedValue(makePayload(displayName, books));
  mockGetPersonalBooks.mockResolvedValue({
    data: { payload: "encrypted-string" },
  });
  render(<PersonalShelfPage {...createProps()} />);
  await waitFor(() => {
    expect(screen.getByText(books[0].title)).toBeInTheDocument();
  });
}

describe("PersonalShelfPage", () => {
  let defaultProps: ReturnType<typeof createProps>;

  beforeEach(() => {
    mockDecrypt.mockReset();
    mockEncrypt.mockReset();
    mockGetPersonalBooks.mockReset();
    mockUpdatePersonalBooks.mockReset();
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
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    fireEvent.click(screen.getByText("重試"));

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });
    expect(mockGetPersonalBooks).toHaveBeenCalledTimes(2);
  });

  it("shows empty state when books array is empty", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", []),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
    ]);

    expect(screen.getByText("(2 本)")).toBeInTheDocument();
  });

  it("shows checkboxes for each book", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
    ]);

    expect(screen.getByLabelText("選取 書籍一")).toBeInTheDocument();
    expect(screen.getByLabelText("選取 書籍二")).toBeInTheDocument();
  });

  it("selecting a book shows floating action bar with count", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 1 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
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

  it("save flow calls encrypt then updatePersonalBooks", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
    ]);

    mockEncrypt.mockResolvedValue("new-encrypted-payload");
    mockUpdatePersonalBooks.mockResolvedValue({ data: { ok: true } });

    // Batch share to make dirty
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));

    // Click save in floating bar
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(mockEncrypt).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdatePersonalBooks).toHaveBeenCalledWith(
      "user-1",
      "new-encrypted-payload",
    );

    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("floating action bar hidden when not dirty and no selection", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
    ]);

    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("status filter '已開放' shows only shared books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
    ]);

    expect(screen.getByText("書籍二")).toBeInTheDocument();

    fireEvent.click(screen.getByText("已開放"));

    expect(screen.getByText("書籍一")).toBeInTheDocument();
    expect(screen.queryByText("書籍二")).not.toBeInTheDocument();
  });

  it("status filter '未開放' shows only unshared books", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
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
      { bookId: "b1", title: "React 入門", author: "作者A", isShared: 1 },
      { bookId: "b2", title: "Vue 入門", author: "作者B", isShared: 1 },
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
      { bookId: "b1", title: "書籍一", author: "張三", isShared: 1 },
      { bookId: "b2", title: "書籍二", author: "李四", isShared: 0 },
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

  it("shows save error when updatePersonalBooks fails", async () => {
    await renderWithBooks([
      { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
    ]);

    mockEncrypt.mockResolvedValue("encrypted");
    mockUpdatePersonalBooks.mockRejectedValue(new Error("儲存失敗"));

    // Batch share to make dirty
    fireEvent.click(screen.getByLabelText("選取 書籍一"));
    fireEvent.click(screen.getByText("設為開放"));
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    });
  });
});
