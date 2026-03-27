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

  it("renders books with titles, authors, and toggle buttons", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });
    expect(screen.getByText("作者A")).toBeInTheDocument();
    expect(screen.getByText("書籍二")).toBeInTheDocument();
    expect(screen.getByText("作者B")).toBeInTheDocument();
    // "開放" appears as book toggle; "未開放" appears as both filter button and book toggle
    expect(screen.getByText("開放")).toBeInTheDocument();
    // Use getAllByText since "未開放" is on both filter button and book toggle
    const allUnshared = screen.getAllByText("未開放");
    expect(allUnshared.length).toBeGreaterThanOrEqual(2); // filter + book toggle
  });

  it("shows total book count in header", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("(2 本)")).toBeInTheDocument();
    });
  });

  it("toggle changes button text from '未開放' to '開放'", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      // "未開放" appears as both filter button and book toggle
      expect(screen.getAllByText("未開放").length).toBeGreaterThanOrEqual(2);
    });

    // The book toggle button has font-medium class; click the last "未開放" (book toggle)
    const toggleButtons = screen.getAllByText("未開放");
    const bookToggle = toggleButtons[toggleButtons.length - 1];
    fireEvent.click(bookToggle);

    expect(screen.getByText("開放")).toBeInTheDocument();
    // Only the filter "未開放" remains, book toggle is now "開放"
    expect(screen.getAllByText("未開放")).toHaveLength(1);
  });

  it("toggle changes button text from '開放' to '未開放'", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("開放")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("開放"));

    // After toggle, "未開放" appears on both filter button and book toggle
    const allUnshared = screen.getAllByText("未開放");
    expect(allUnshared.length).toBe(2);
    // "開放" should no longer appear as a book toggle (only "已開放" filter remains)
    expect(screen.queryByText("開放")).not.toBeInTheDocument();
  });

  it("save button is disabled when no changes have been made", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });

    const saveButton = screen.getByText("儲存變更");
    expect(saveButton).toBeDisabled();
  });

  it("save button becomes enabled after toggling a book", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("未開放").length).toBeGreaterThanOrEqual(2);
    });

    const saveButton = screen.getByText("儲存變更");
    expect(saveButton).toBeDisabled();

    // Click the book toggle (last "未開放"), not the filter button
    const toggleButtons = screen.getAllByText("未開放");
    fireEvent.click(toggleButtons[toggleButtons.length - 1]);

    expect(saveButton).not.toBeDisabled();
  });

  it("save flow calls encrypt then updatePersonalBooks", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });
    mockEncrypt.mockResolvedValue("new-encrypted-payload");
    mockUpdatePersonalBooks.mockResolvedValue({ data: { ok: true } });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("未開放").length).toBeGreaterThanOrEqual(2);
    });

    // Toggle to make dirty (click book toggle, not filter button)
    const toggleButtons = screen.getAllByText("未開放");
    fireEvent.click(toggleButtons[toggleButtons.length - 1]);

    // Click save
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(mockEncrypt).toHaveBeenCalledTimes(1);
    });
    expect(mockUpdatePersonalBooks).toHaveBeenCalledWith(
      "user-1",
      "new-encrypted-payload",
    );

    // After save, button shows "已儲存"
    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });
  });

  it("save button is disabled again after successful save", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });
    mockEncrypt.mockResolvedValue("new-encrypted-payload");
    mockUpdatePersonalBooks.mockResolvedValue({ data: { ok: true } });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("未開放").length).toBeGreaterThanOrEqual(2);
    });

    const toggleButtons = screen.getAllByText("未開放");
    fireEvent.click(toggleButtons[toggleButtons.length - 1]);
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(screen.getByText("已儲存")).toBeInTheDocument();
    });

    // Save button should be disabled after successful save (isDirty reset to false)
    expect(screen.getByText("已儲存")).toBeDisabled();
  });

  it("status filter '已開放' shows only shared books", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });
    expect(screen.getByText("書籍二")).toBeInTheDocument();

    // Click "已開放" filter
    fireEvent.click(screen.getByText("已開放"));

    expect(screen.getByText("書籍一")).toBeInTheDocument();
    expect(screen.queryByText("書籍二")).not.toBeInTheDocument();
  });

  it("status filter '未開放' shows only unshared books", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });

    // Click "未開放" filter button (first match), not the book toggle (last match)
    const filterButtons = screen.getAllByText("未開放");
    fireEvent.click(filterButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("書籍二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書籍一")).not.toBeInTheDocument();
  });

  it("'全部' filter shows all books", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "作者B", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });

    // Filter to "已開放" first
    fireEvent.click(screen.getByText("已開放"));
    expect(screen.queryByText("書籍二")).not.toBeInTheDocument();

    // Switch back to "全部"
    fireEvent.click(screen.getByText("全部"));
    expect(screen.getByText("書籍一")).toBeInTheDocument();
    expect(screen.getByText("書籍二")).toBeInTheDocument();
  });

  it("search filters books by title", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "React 入門", author: "作者A", isShared: 1 },
        { bookId: "b2", title: "Vue 入門", author: "作者B", isShared: 1 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("React 入門")).toBeInTheDocument();
    });
    expect(screen.getByText("Vue 入門")).toBeInTheDocument();

    // Switch to fake timers to control debounce
    vi.useFakeTimers();

    fireEvent.change(screen.getByPlaceholderText("搜尋書名或作者"), {
      target: { value: "React" },
    });

    // Before debounce, both books still visible
    expect(screen.getByText("Vue 入門")).toBeInTheDocument();

    // Advance debounce timer and flush React updates
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText("React 入門")).toBeInTheDocument();
    expect(screen.queryByText("Vue 入門")).not.toBeInTheDocument();
  });

  it("search filters books by author", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "張三", isShared: 1 },
        { bookId: "b2", title: "書籍二", author: "李四", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("書籍一")).toBeInTheDocument();
    });

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
    mockDecrypt.mockResolvedValue(
      makePayload("TestUser", [
        { bookId: "b1", title: "書籍一", author: "作者A", isShared: 0 },
      ]),
    );
    mockGetPersonalBooks.mockResolvedValue({
      data: { payload: "encrypted-string" },
    });
    mockEncrypt.mockResolvedValue("encrypted");
    mockUpdatePersonalBooks.mockRejectedValue(new Error("儲存失敗"));

    render(<PersonalShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText("未開放").length).toBeGreaterThanOrEqual(2);
    });

    const toggleButtons = screen.getAllByText("未開放");
    fireEvent.click(toggleButtons[toggleButtons.length - 1]);
    fireEvent.click(screen.getByText("儲存變更"));

    await waitFor(() => {
      expect(screen.getByText("儲存失敗")).toBeInTheDocument();
    });
  });
});
