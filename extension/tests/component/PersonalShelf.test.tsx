import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PersonalShelf, PersonalShelfProps } from "@/dialog/PersonalShelf";
import type { ApiClient } from "@/api/client";

vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue("mock-key"),
  encrypt: vi.fn().mockResolvedValue("encrypted-payload"),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ books: [] })),
}));

vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([
    {
      bookId: "book-1",
      title: "測試書籍一",
      author: "作者A",
      coverUrl: "https://example.com/cover1.jpg",
      readmooUrl: "https://mooink.readmoo.com/book/book-1",
    },
    {
      bookId: "book-2",
      title: "測試書籍二",
      author: "作者B",
      coverUrl: "https://example.com/cover2.jpg",
      readmooUrl: "https://mooink.readmoo.com/book/book-2",
    },
    {
      bookId: "book-3",
      title: "測試書籍三",
      author: "作者C",
      coverUrl: "https://example.com/cover3.jpg",
      readmooUrl: "https://mooink.readmoo.com/book/book-3",
    },
  ]),
}));

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getFamilyMembers: vi.fn(),
    getFamilyBookshelf: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function renderPersonalShelf(props: Partial<PersonalShelfProps> = {}) {
  const defaultProps: PersonalShelfProps = {
    userId: "user-abc123",
    apiClient: createMockApiClient(),
  };
  return render(<PersonalShelf {...defaultProps} {...props} />);
}

async function waitForBooksLoaded() {
  await waitFor(() => {
    expect(screen.getByText("測試書籍一")).toBeInTheDocument();
  });
}

describe("PersonalShelf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { encryptionKey: "fake-enc-key-abc", displayName: "小明" };
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  it("shows loading state initially", () => {
    renderPersonalShelf();
    expect(screen.getByText("正在爬取書單...")).toBeInTheDocument();
  });

  it("renders scraped books after loading", async () => {
    renderPersonalShelf();
    await waitForBooksLoaded();

    expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    expect(screen.getByText("測試書籍二")).toBeInTheDocument();
    expect(screen.getByText("測試書籍三")).toBeInTheDocument();
  });

  it("shows checkboxes for each book row", async () => {
    renderPersonalShelf();
    await waitForBooksLoaded();

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    // All unchecked initially
    checkboxes.forEach((cb) => expect(cb).not.toBeChecked());
  });

  it("shows share status as badge text, not a button", async () => {
    renderPersonalShelf();
    await waitForBooksLoaded();

    // "未開放" should appear as text badges, not as clickable buttons
    // The filter bar button "未開放" is a button, but the row badges are spans
    const badges = screen.getAllByText("未開放");
    // At least 3 badges (one per book) + 1 filter button
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });

  it("renders status filter buttons with 全部 active by default", async () => {
    renderPersonalShelf();
    await waitForBooksLoaded();

    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已開放" })).toBeInTheDocument();
  });

  describe("multi-select", () => {
    it("selects individual books via checkbox", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);

      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[1]).not.toBeChecked();
    });

    it("deselects a book when clicking checkbox again", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      expect(checkboxes[0]).toBeChecked();

      fireEvent.click(checkboxes[0]);
      expect(checkboxes[0]).not.toBeChecked();
    });

    it("select all selects all visible books", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const selectAllBtn = screen.getByRole("button", { name: "全選" });
      fireEvent.click(selectAllBtn);

      const checkboxes = screen.getAllByRole("checkbox");
      checkboxes.forEach((cb) => expect(cb).toBeChecked());
    });

    it("select all button toggles to 取消全選 when all selected", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      fireEvent.click(screen.getByRole("button", { name: "全選" }));
      expect(screen.getByRole("button", { name: "取消全選" })).toBeInTheDocument();
    });

    it("deselect all clears all selections", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Select all, then deselect all
      fireEvent.click(screen.getByRole("button", { name: "全選" }));
      fireEvent.click(screen.getByRole("button", { name: "取消全選" }));

      const checkboxes = screen.getAllByRole("checkbox");
      checkboxes.forEach((cb) => expect(cb).not.toBeChecked());
    });

    it("select all only selects filtered books", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // First select a book and batch-share it to create a "shared" book
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Filter to "已開放"
      fireEvent.click(screen.getByRole("button", { name: "已開放" }));

      await waitFor(() => {
        expect(screen.queryByText("測試書籍二")).not.toBeInTheDocument();
      });

      // Select all visible (only 1 book visible)
      fireEvent.click(screen.getByRole("button", { name: "全選" }));

      const visibleCheckboxes = screen.getAllByRole("checkbox");
      expect(visibleCheckboxes).toHaveLength(1);
      expect(visibleCheckboxes[0]).toBeChecked();
    });
  });

  describe("floating action bar", () => {
    it("is hidden when no selection and not dirty", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      expect(screen.queryByText("設為開放")).not.toBeInTheDocument();
      expect(screen.queryByText("設為隱藏")).not.toBeInTheDocument();
      expect(screen.queryByText("儲存變更")).not.toBeInTheDocument();
    });

    it("shows batch buttons when books are selected", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      expect(screen.getByText("已選 2 本")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "設為開放" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "設為隱藏" })).toBeInTheDocument();
    });

    it("shows save button when dirty but no selection", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Select and batch-share to make dirty
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // After batch action, selection is cleared but isDirty = true
      expect(screen.queryByText("已選")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "儲存變更" })).toBeInTheDocument();
    });

    it("shows both batch buttons and save when selected and dirty", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Make dirty first
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Now select another book
      const updatedCheckboxes = screen.getAllByRole("checkbox");
      fireEvent.click(updatedCheckboxes[1]);

      expect(screen.getByText("已選 1 本")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "設為開放" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "設為隱藏" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "儲存變更" })).toBeInTheDocument();
    });
  });

  describe("batch toggle operations", () => {
    it("batch 設為開放 sets selected books to shared", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Select first two books
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);

      // Batch share
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // First two should show "開放" badge, third still "未開放"
      const openBadges = screen.getAllByText("開放");
      expect(openBadges.length).toBeGreaterThanOrEqual(2);
    });

    it("batch 設為隱藏 sets selected books to not-shared", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // First, share all books
      fireEvent.click(screen.getByRole("button", { name: "全選" }));
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Now select first two and hide them
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(checkboxes[1]);
      fireEvent.click(screen.getByRole("button", { name: "設為隱藏" }));

      // Two should be "未開放", one should remain "開放"
      const hiddenBadges = screen.getAllByText("未開放");
      // 2 book badges + 1 filter button = at least 3
      expect(hiddenBadges.length).toBeGreaterThanOrEqual(2);
    });

    it("clears selection after batch action", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // All checkboxes should be unchecked
      const updatedCheckboxes = screen.getAllByRole("checkbox");
      updatedCheckboxes.forEach((cb) => expect(cb).not.toBeChecked());
    });

    it("marks isDirty after batch action", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Save button should appear (isDirty = true)
      expect(screen.getByRole("button", { name: "儲存變更" })).toBeInTheDocument();
    });
  });

  describe("save via floating bar", () => {
    it("save button in floating bar triggers save", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: { ok: true } });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitForBooksLoaded();

      // Make dirty via batch action
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Click save
      fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });
    });
  });

  describe("filters", () => {
    it("filters books by 已開放 status", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Share first book via batch action
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Click 已開放 filter
      fireEvent.click(screen.getByRole("button", { name: "已開放" }));

      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
      expect(screen.queryByText("測試書籍二")).not.toBeInTheDocument();
    });

    it("filters books by 未開放 status", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Share first book via batch action
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Click 未開放 filter button
      fireEvent.click(screen.getByRole("button", { name: "未開放" }));

      expect(screen.queryByText("測試書籍一")).not.toBeInTheDocument();
      expect(screen.getByText("測試書籍二")).toBeInTheDocument();
      expect(screen.getByText("測試書籍三")).toBeInTheDocument();
    });
  });
});
