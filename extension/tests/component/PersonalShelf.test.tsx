import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PersonalShelf, PersonalShelfProps } from "@/dialog/PersonalShelf";
import { BoolFlag, type ApiClient, type FamilyMember } from "@/api/client";
import { PERSONAL_BOOKS_CACHE_KEY } from "@/constants";

const mockUseFamilyData = vi.fn();

vi.mock("@/dialog/FamilyDataContext", () => ({
  useFamilyData: () => mockUseFamilyData(),
}));

const mockUseBookSync = vi.fn().mockReturnValue({
  syncStatus: "idle",
  syncError: "",
  lastSyncBooks: [],
  triggerManualSync: vi.fn(),
  autoSyncDone: false,
  progressMessage: "",
});

vi.mock("@/dialog/useBookSync", () => ({
  useBookSync: (...args: unknown[]) => mockUseBookSync(...args),
}));

// usePersonalBooks no longer scrapes — its baseline comes from the API record
// (cache-first reconciled against the server). The scraper is mocked only so an
// accidental call would surface; books for these tests are supplied via the API.
vi.mock("@/content/scraper", () => ({
  scrapeBooks: vi.fn().mockResolvedValue([]),
  scrapeArchivedBooks: vi.fn().mockResolvedValue([]),
  formatScrapeProgress: (page: number, count: number) =>
    `正在讀取第 ${page} 頁，已收集 ${count} 本…`,
}));

type TestBook = {
  bookId: string;
  title: string;
  author: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isbn: string;
  isShared: BoolFlag;
  isArchived: BoolFlag;
};

function makeBook(overrides: Partial<TestBook> & { bookId: string; title: string }): TestBook {
  return {
    author: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${overrides.bookId}`,
    category: "",
    isbn: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

/** The default 3-book set every test starts from (supplied via the API record). */
const DEFAULT_BOOKS: TestBook[] = [
  makeBook({ bookId: "book-1", title: "測試書籍一", author: "作者A", coverUrl: "https://example.com/cover1.jpg" }),
  makeBook({ bookId: "book-2", title: "測試書籍二", author: "作者B", coverUrl: "https://example.com/cover2.jpg" }),
  makeBook({ bookId: "book-3", title: "測試書籍三", author: "作者C", coverUrl: "https://example.com/cover3.jpg" }),
];

/** Build a getPersonalBooks mock that returns the given book set as the server record. */
function getPersonalBooksReturning(books: TestBook[]) {
  return vi.fn().mockResolvedValue({
    data: {
      schemaVersion: 1,
      userId: "user-abc123",
      displayName: "小明",
      books,
      lastUpdated: "2026-01-01T00:00:00.000Z",
    },
  });
}

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn(),
    // No server record by default: the books for these tests arrive via the
    // auto-sync stream (useBookSync.lastSyncBooks). With no server record, a
    // save goes out as a full PUT (updatePersonalBooks) — see decideSaveStrategy.
    getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    patchPersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true, applied: 0 } }),
    getFamilyMembers: vi.fn(),
    getFamilyBookshelf: vi.fn(),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

/** Configure the mocked useBookSync to stream `books` back via lastSyncBooks (the "open shelf → auto full sync" path). */
function setSyncBooks(books: TestBook[]) {
  mockUseBookSync.mockReturnValue({
    syncStatus: "idle",
    syncError: "",
    lastSyncBooks: books,
    triggerManualSync: vi.fn(),
    autoSyncDone: true,
    progressMessage: "",
  });
}

/**
 * Seed chrome.storage.local so the cache-first load picks up `books` as its
 * baseline (and originalBooks snapshot). Using the cache — rather than the API
 * record — means the books are NOT server-known, so a save goes out as a full
 * PUT (updatePersonalBooks), matching what the save-flow tests assert.
 */
function seedCache(books: TestBook[]) {
  const store: Record<string, unknown> = {
    displayName: "小明",
    [PERSONAL_BOOKS_CACHE_KEY]: JSON.stringify(books),
  };
  vi.mocked(chrome.storage.local.get).mockImplementation(
    (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (typeof key === "string" && key in store) result[key] = store[key];
      }
      if (typeof callback === "function") {
        callback(result);
        return undefined as unknown as void;
      }
      return Promise.resolve(result) as unknown as void;
    },
  );
}

function renderPersonalShelf(
  props: Partial<PersonalShelfProps> = {},
  books: TestBook[] = DEFAULT_BOOKS,
) {
  seedCache(books);
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
    // Reset useFamilyData mock — provides displayName via members list
    const defaultMembers: FamilyMember[] = [
      { userId: "user-abc123", displayName: "小明" },
    ];
    mockUseFamilyData.mockReturnValue({ members: defaultMembers });
    // Reset useBookSync mock to default
    mockUseBookSync.mockReturnValue({
      syncStatus: "idle",
      syncError: "",
      lastSyncBooks: [],
      triggerManualSync: vi.fn(),
      autoSyncDone: false,
      progressMessage: "",
    });
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { displayName: "小明" };
        if (typeof callback === "function") {
          callback(result);
        }
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  afterEach(async () => {
    // Flush pending async effects before cleanup
    await act(async () => {});
  });

  it("shows loading state initially while the API record resolves", async () => {
    // Hold the API open so the brief "loading" state is observable.
    let resolveApi: (v: { data: null }) => void;
    const apiClient = createMockApiClient({
      getPersonalBooks: vi.fn().mockReturnValue(
        new Promise((resolve) => { resolveApi = resolve; }),
      ),
    });
    seedCache(DEFAULT_BOOKS);

    render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

    // New copy: cache-first load shows "載入中..." (not the old scrape message).
    expect(screen.getByText("載入中...")).toBeInTheDocument();

    await act(async () => {
      resolveApi!({ data: null });
    });
  });

  it("shows the auto-sync progress message when useBookSync reports one (Wave G)", async () => {
    mockUseBookSync.mockReturnValue({
      syncStatus: "syncing",
      syncError: "",
      lastSyncBooks: [],
      triggerManualSync: vi.fn(),
      autoSyncDone: false,
      progressMessage: "正在讀取第 3 頁，已收集 600 本…",
    });

    render(<PersonalShelf userId="user-abc123" apiClient={createMockApiClient()} />);

    await waitFor(() => {
      expect(
        screen.getByText("正在讀取第 3 頁，已收集 600 本…"),
      ).toBeInTheDocument();
    });
  });

  it("renders books streamed from the auto-sync after loading", async () => {
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

  describe("cancel changes", () => {
    it("cancel button appears only when dirty", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // Not dirty — cancel button should not exist
      expect(screen.queryByRole("button", { name: "取消變更" })).not.toBeInTheDocument();

      // Select a book (no dirty yet)
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      expect(screen.queryByRole("button", { name: "取消變更" })).not.toBeInTheDocument();

      // Make dirty via batch share
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));
      expect(screen.getByRole("button", { name: "取消變更" })).toBeInTheDocument();
    });

    it("cancel restores original book states and clears dirty and selection", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      // All books start as 未開放 — verify via badges
      const initialHiddenBadges = screen.getAllByText("未開放");
      const initialBadgeCount = initialHiddenBadges.length;

      // Share first book
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Verify it changed
      expect(screen.getAllByText("開放").length).toBeGreaterThanOrEqual(1);

      // Select another book before cancelling
      const updatedCheckboxes = screen.getAllByRole("checkbox");
      fireEvent.click(updatedCheckboxes[1]);
      expect(updatedCheckboxes[1]).toBeChecked();

      // Click cancel
      fireEvent.click(screen.getByRole("button", { name: "取消變更" }));

      // Should restore original state — all 未開放 again
      const restoredHiddenBadges = screen.getAllByText("未開放");
      expect(restoredHiddenBadges.length).toBe(initialBadgeCount);

      // isDirty should be false — no save or cancel button
      expect(screen.queryByRole("button", { name: "儲存變更" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "取消變更" })).not.toBeInTheDocument();

      // Selection should be cleared
      const finalCheckboxes = screen.getAllByRole("checkbox");
      finalCheckboxes.forEach((cb) => expect(cb).not.toBeChecked());
    });
  });

  describe("save via floating bar", () => {
    it("save button in floating bar triggers save", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: { ok: true } });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      seedCache(DEFAULT_BOOKS);
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

      // Click 未開放 filter button (first match is the filter bar, others are per-book toggles)
      fireEvent.click(screen.getAllByRole("button", { name: "未開放" })[0]);

      expect(screen.queryByText("測試書籍一")).not.toBeInTheDocument();
      expect(screen.getByText("測試書籍二")).toBeInTheDocument();
      expect(screen.getByText("測試書籍三")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message when the load (API fetch) fails", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("Load failed")),
      });
      seedCache(DEFAULT_BOOKS);

      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitFor(() => {
        expect(screen.getByText("Load failed")).toBeInTheDocument();
      });

      // Should show a return button
      expect(screen.getByRole("button", { name: "返回" })).toBeInTheDocument();
    });

    it("return button in error state transitions to ready", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("Error test")),
      });
      setSyncBooks([]);

      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitFor(() => {
        expect(screen.getByText("Error test")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "返回" }));

      // After clicking return, the error should go away
      // (status changes to "ready" but there are no books, so we check error is gone)
      expect(screen.queryByText("Error test")).not.toBeInTheDocument();
    });

    it("shows generic error for non-Error exceptions", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockRejectedValue("string error"),
      });
      seedCache(DEFAULT_BOOKS);

      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
      });
    });
  });

  describe("saved books from API", () => {
    it("loads and merges saved books from API", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: {
            books: [
              {
                bookId: "book-1",
                title: "測試書籍一",
                author: "作者A",
                coverUrl: "https://example.com/cover1.jpg",
                readmooUrl: "https://readmoo.com/book/book-1",
                isShared: BoolFlag.TRUE,
                isbn: "",
              },
            ],
          },
        }),
      });

      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitFor(() => {
        expect(screen.getByText("測試書籍一")).toBeInTheDocument();
      });

      // The book should have preserved its isShared=1 from saved data
      const openBadges = screen.queryAllByText("開放");
      expect(openBadges.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("save flow", () => {
    it("clears isDirty after successful save", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: { ok: true } });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      seedCache(DEFAULT_BOOKS);
      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitForBooksLoaded();

      // Make dirty
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Save button should be visible
      expect(screen.getByRole("button", { name: "儲存變更" })).toBeInTheDocument();

      // Click save
      fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

      // After successful save, isDirty should be false — floating bar disappears
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "儲存變更" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "取消變更" })).not.toBeInTheDocument();
      });
    });

    it("sends server-authoritative displayName from context, not chrome.storage.local", async () => {
      // Set useFamilyData to return the server-authoritative name. The cache/storage
      // displayName ("小明") must be ignored in favour of this context value.
      mockUseFamilyData.mockReturnValue({
        members: [{ userId: "user-abc123", displayName: "伺服器名稱" }],
      });

      const mockUpdate = vi.fn().mockResolvedValue({ data: { ok: true } });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      seedCache(DEFAULT_BOOKS);
      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitForBooksLoaded();

      // Make dirty and save
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));
      fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });

      // Verify the saved payload uses the server displayName, not the stale local one
      const savedPayload = mockUpdate.mock.calls[0][1];
      expect(savedPayload.displayName).toBe("伺服器名稱");
    });

    it("shows error when save fails via API error", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({
        error: { code: "SAVE_FAILED", message: "儲存失敗" },
      });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      seedCache(DEFAULT_BOOKS);
      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitForBooksLoaded();

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

      await waitFor(() => {
        expect(screen.getByText("儲存失敗")).toBeInTheDocument();
      });
    });

  });

  describe("sync button", () => {
    it("shows 同步書櫃 button", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      expect(screen.getByRole("button", { name: "同步書櫃" })).toBeInTheDocument();
    });

    it("shows book count in header", async () => {
      renderPersonalShelf();
      await waitForBooksLoaded();

      expect(screen.getByText("(3 本)")).toBeInTheDocument();
    });
  });

  describe("empty states", () => {
    it("shows 尚無書籍 when active books are empty", async () => {
      // No server record and no synced books → empty ready state.
      renderPersonalShelf({}, []);

      await waitFor(() => {
        expect(screen.getByText("尚無書籍")).toBeInTheDocument();
      });
    });
  });

  describe("archive features", () => {
    it("archive view tabs appear when syncArchived is enabled and there are archived books", async () => {
      // Synced books include an archived book.
      const books = [
        makeBook({ bookId: "book-1", title: "測試書籍一", author: "作者A", coverUrl: "https://example.com/cover1.jpg" }),
        makeBook({ bookId: "book-archived", title: "封存書籍一", author: "作者D", coverUrl: "https://example.com/cover-a.jpg", isArchived: BoolFlag.TRUE }),
      ];

      // Mock GET_SYNC_ARCHIVED to return 1
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf({}, books);
      await waitFor(() => {
        expect(screen.getByText("測試書籍一")).toBeInTheDocument();
      });

      // Archive tabs should be visible — use exact match with function
      expect(screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^未封存/.test(el.textContent ?? ""),
      )).toBeInTheDocument();
      expect(screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^封存 \(/.test(el.textContent ?? ""),
      )).toBeInTheDocument();
    });

    it("archive view tabs do NOT appear when syncArchived is 0", async () => {
      // Default sendMessage mock doesn't call back, so syncArchived stays 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 0 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf();
      await waitForBooksLoaded();

      expect(screen.queryByText((_content, el) =>
        el?.tagName === "BUTTON" && /^未封存/.test(el.textContent ?? ""),
      )).not.toBeInTheDocument();
      expect(screen.queryByText((_content, el) =>
        el?.tagName === "BUTTON" && /^封存 \(/.test(el.textContent ?? ""),
      )).not.toBeInTheDocument();
    });

    it("clicking '未封存' tab shows only active books", async () => {
      const books = [
        makeBook({ bookId: "book-1", title: "活躍書籍", author: "作者A" }),
        makeBook({ bookId: "book-2", title: "已封存書", author: "作者B", isArchived: BoolFlag.TRUE }),
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf({}, books);
      await waitFor(() => {
        expect(screen.getByText("活躍書籍")).toBeInTheDocument();
      });

      // Default view is "active" tab — click it to be explicit
      const activeTab = screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^未封存/.test(el.textContent ?? ""),
      );
      fireEvent.click(activeTab);

      expect(screen.getByText("活躍書籍")).toBeInTheDocument();
      expect(screen.queryByText("已封存書")).not.toBeInTheDocument();
    });

    it("clicking '封存' tab shows only archived books", async () => {
      const books = [
        makeBook({ bookId: "book-1", title: "活躍書籍", author: "作者A" }),
        makeBook({ bookId: "book-2", title: "已封存書", author: "作者B", isArchived: BoolFlag.TRUE }),
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf({}, books);
      await waitFor(() => {
        expect(screen.getByText("活躍書籍")).toBeInTheDocument();
      });

      // Click the "封存" tab (starts with 封存, not 未封存)
      const archivedTab = screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^封存 \(/.test(el.textContent ?? ""),
      );
      fireEvent.click(archivedTab);

      expect(screen.queryByText("活躍書籍")).not.toBeInTheDocument();
      expect(screen.getByText("已封存書")).toBeInTheDocument();
    });

    it("shows '尚無封存書籍' when archived view has no books", async () => {
      // All books are active, none archived
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf();
      await waitForBooksLoaded();

      // Click the "封存" tab — there are 0 archived books
      const archivedTab = screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^封存 \(/.test(el.textContent ?? ""),
      );
      fireEvent.click(archivedTab);

      expect(screen.getByText("尚無封存書籍")).toBeInTheDocument();
    });
  });

  describe("personalBooksCache", () => {
    // Note: the load path no longer writes the cache (the self-contained display
    // scrape was removed). The cache is now written by syncBooks (during sync) and
    // by handleSave — the latter is exercised below.
    it("updates cache after successful save", async () => {
      const mockUpdate = vi.fn().mockResolvedValue({ data: { ok: true } });
      const apiClient = createMockApiClient({ updatePersonalBooks: mockUpdate });
      seedCache(DEFAULT_BOOKS);
      render(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);

      await waitForBooksLoaded();

      // Clear mock calls from load phase
      vi.mocked(chrome.storage.local.set).mockClear();

      // Make dirty via batch action
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]);
      fireEvent.click(screen.getByRole("button", { name: "設為開放" }));

      // Click save
      fireEvent.click(screen.getByRole("button", { name: "儲存變更" }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });

      // After save, cache should be updated
      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
          { [PERSONAL_BOOKS_CACHE_KEY]: expect.any(String) },
        );
      });

      // Verify the cached books include the toggled share status
      const setCalls = vi.mocked(chrome.storage.local.set).mock.calls;
      const cacheCall = setCalls.find(
        (call) => call[0] && typeof call[0] === "object" && PERSONAL_BOOKS_CACHE_KEY in (call[0] as Record<string, unknown>),
      );
      expect(cacheCall).toBeDefined();
      const cached = JSON.parse((cacheCall![0] as Record<string, string>)[PERSONAL_BOOKS_CACHE_KEY]);
      const book1 = cached.find((b: { bookId: string }) => b.bookId === "book-1");
      expect(book1).toBeDefined();
      expect(book1.isShared).toBe(BoolFlag.TRUE);
    });
  });

  describe("category filter reset", () => {
    it("resets category filter when status filter changes", async () => {
      const books = [
        makeBook({ bookId: "book-1", title: "奇幻書籍", author: "作者A", category: "奇幻冒險" }),
        makeBook({ bookId: "book-2", title: "韓國書籍", author: "作者B", category: "韓國耽美" }),
      ];

      renderPersonalShelf({}, books);
      await waitFor(() => {
        expect(screen.getByText("奇幻書籍")).toBeInTheDocument();
      });

      // Open category filter popover and select a category
      fireEvent.click(screen.getByLabelText("篩選分類"));
      fireEvent.click(screen.getByText("奇幻冒險"));

      // Only the matching book should be visible
      expect(screen.getByText("奇幻書籍")).toBeInTheDocument();
      expect(screen.queryByText("韓國書籍")).not.toBeInTheDocument();

      // Switch status filter — category should reset
      fireEvent.click(screen.getByText("已開放"));
      fireEvent.click(screen.getByText("全部"));

      // Both books should be visible (category filter was reset)
      await waitFor(() => {
        expect(screen.getByText("奇幻書籍")).toBeInTheDocument();
        expect(screen.getByText("韓國書籍")).toBeInTheDocument();
      });
    });
  });

  describe("lastSyncBooks merge preserves isShared", () => {
    it("preserves existing isShared state when lastSyncBooks arrives", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: {
            books: [
              {
                bookId: "book-1",
                title: "測試書籍一",
                author: "作者A",
                coverUrl: "https://example.com/cover1.jpg",
                readmooUrl: "https://readmoo.com/book/book-1",
                isShared: BoolFlag.TRUE,
                isbn: "",
              },
            ],
          },
        }),
      });

      // Initially return no sync books
      mockUseBookSync.mockReturnValue({
        syncStatus: "idle",
        syncError: "",
        lastSyncBooks: [],
        triggerManualSync: vi.fn(),
        autoSyncDone: false,
      });

      const { rerender } = render(
        <PersonalShelf userId="user-abc123" apiClient={apiClient} />,
      );

      // Wait for initial load — book-1 should be shared from saved data
      await waitFor(() => {
        expect(screen.getByText("測試書籍一")).toBeInTheDocument();
      });
      const openBadges = screen.queryAllByText("開放");
      expect(openBadges.length).toBeGreaterThanOrEqual(1);

      // Now simulate lastSyncBooks arriving (same book-1 + a new book-4)
      // The remap in PersonalShelf lines 125-136 intentionally omits isShared
      mockUseBookSync.mockReturnValue({
        syncStatus: "done",
        syncError: "",
        lastSyncBooks: [
          {
            bookId: "book-1",
            title: "測試書籍一（更新版）",
            author: "作者A",
            coverUrl: "https://example.com/cover1-v2.jpg",
            readmooUrl: "https://readmoo.com/book/book-1",
          },
          {
            bookId: "book-4",
            title: "新書籍四",
            author: "作者D",
            coverUrl: "https://example.com/cover4.jpg",
            readmooUrl: "https://readmoo.com/book/book-4",
          },
        ],
        triggerManualSync: vi.fn(),
        autoSyncDone: true,
      });

      // Re-render to trigger the useEffect that reacts to lastSyncBooks
      await act(async () => {
        rerender(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);
      });

      await waitFor(() => {
        // New book should appear
        expect(screen.getByText("新書籍四")).toBeInTheDocument();
      });

      // book-1 should still be shared (isShared preserved by mergeBooks)
      // Check that "開放" badge still exists (at least 1 for book-1)
      const updatedOpenBadges = screen.queryAllByText("開放");
      expect(updatedOpenBadges.length).toBeGreaterThanOrEqual(1);

      // book-4 is new, should default to not-shared
      // The "未開放" badge count should include book-4
      const hiddenBadges = screen.queryAllByText("未開放");
      expect(hiddenBadges.length).toBeGreaterThanOrEqual(1);
    });

    it("new books from sync default to not-shared", async () => {
      // Start with 3 server-known books, none shared.
      mockUseBookSync.mockReturnValue({
        syncStatus: "idle",
        syncError: "",
        lastSyncBooks: [],
        triggerManualSync: vi.fn(),
        autoSyncDone: false,
      });

      const apiClient = createMockApiClient({
        getPersonalBooks: getPersonalBooksReturning(DEFAULT_BOOKS),
      });
      const { rerender } = render(
        <PersonalShelf userId="user-abc123" apiClient={apiClient} />,
      );

      await waitForBooksLoaded();

      // All 3 initial books should be not-shared
      const initialHidden = screen.getAllByText("未開放");
      // 3 badges + 1 filter button = at least 3
      expect(initialHidden.length).toBeGreaterThanOrEqual(3);

      // Simulate sync bringing a new book
      mockUseBookSync.mockReturnValue({
        syncStatus: "done",
        syncError: "",
        lastSyncBooks: [
          {
            bookId: "book-new",
            title: "全新同步書",
            author: "新作者",
            coverUrl: "https://example.com/new.jpg",
            readmooUrl: "https://readmoo.com/book/book-new",
          },
        ],
        triggerManualSync: vi.fn(),
        autoSyncDone: true,
      });

      await act(async () => {
        rerender(<PersonalShelf userId="user-abc123" apiClient={apiClient} />);
      });

      await waitFor(() => {
        expect(screen.getByText("全新同步書")).toBeInTheDocument();
      });

      // The new book should default to not-shared (no "開放" badge for it)
      // Total "未開放" badges should include the new book
      const updatedHidden = screen.getAllByText("未開放");
      expect(updatedHidden.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Load More (Wave G)", () => {
    function makeManyBooks(count: number, isArchived = BoolFlag.FALSE): TestBook[] {
      return Array.from({ length: count }, (_, i) =>
        makeBook({
          bookId: `book-${i + 1}`,
          title: `書籍 ${i + 1}`,
          author: `作者${i + 1}`,
          coverUrl: "https://example.com/cover.jpg",
          isArchived,
        }),
      );
    }

    // Inject a small pageSize so the same pagination logic is exercised with
    // far fewer rendered BookRows, keeping these tests fast and non-flaky.
    const PAGE_SIZE = 10;

    it("shows Load More button with count text when items exceed pageSize", async () => {
      renderPersonalShelf({ pageSize: PAGE_SIZE }, makeManyBooks(25));

      await waitFor(() => {
        expect(screen.getByText("書籍 1")).toBeInTheDocument();
      });

      expect(
        screen.getByRole("button", { name: /載入更多.*已顯示 10.*共 25 本/ }),
      ).toBeInTheDocument();
    });

    it("does not show Load More button when items fit in pageSize", async () => {
      // Fewer than pageSize → everything fits on one page → no Load More button.
      renderPersonalShelf({ pageSize: PAGE_SIZE }, makeManyBooks(8));

      await waitFor(() => {
        expect(screen.getByText("書籍 1")).toBeInTheDocument();
      });

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });

    it("click Load More appends pageSize to visible count", async () => {
      renderPersonalShelf({ pageSize: PAGE_SIZE }, makeManyBooks(25));

      await waitFor(() => {
        expect(screen.getByText("書籍 1")).toBeInTheDocument();
      });

      const button = screen.getByRole("button", { name: /載入更多.*已顯示 10.*共 25 本/ });
      fireEvent.click(button);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 20.*共 25 本/ }),
        ).toBeInTheDocument();
      });
    });

    it("hides Load More button when status filter narrows the view", async () => {
      renderPersonalShelf({ pageSize: PAGE_SIZE }, makeManyBooks(25));

      await waitFor(() => {
        expect(screen.getByText("書籍 1")).toBeInTheDocument();
      });

      // Click "已開放" status filter — narrows view → narrowingActive=true → button hidden
      fireEvent.click(screen.getByRole("button", { name: "已開放" }));

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });

    it("resets visibleCount when switching archive tabs (Q-B 視角切換類)", async () => {
      const books = [
        ...makeManyBooks(25, BoolFlag.FALSE),
        ...makeManyBooks(5, BoolFlag.TRUE).map((b, i) => ({
          ...b,
          bookId: `archived-${i}`,
          title: `封存書 ${i}`,
        })),
      ];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(chrome.runtime.sendMessage) as any).mockImplementation(
        (message: unknown, callback?: (response: unknown) => void) => {
          const msg = message as { type: string };
          if (msg.type === "GET_SYNC_ARCHIVED" && callback) {
            callback({ syncArchived: 1 });
          }
          return undefined as unknown as Promise<unknown>;
        },
      );

      renderPersonalShelf({ pageSize: PAGE_SIZE }, books);

      await waitFor(() => {
        expect(screen.getByText("書籍 1")).toBeInTheDocument();
      });

      // Click Load More — visible 10 → 20
      fireEvent.click(screen.getByRole("button", { name: /載入更多.*已顯示 10.*共 25 本/ }));
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 20.*共 25 本/ }),
        ).toBeInTheDocument();
      });

      // Switch to archived tab
      const archivedTab = screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^封存 \(/.test(el.textContent ?? ""),
      );
      fireEvent.click(archivedTab);

      // Switch back to active tab — visibleCount should reset to 10
      const activeTab = screen.getByText((_content, el) =>
        el?.tagName === "BUTTON" && /^未封存/.test(el.textContent ?? ""),
      );
      fireEvent.click(activeTab);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 10.*共 25 本/ }),
        ).toBeInTheDocument();
      });
    });
  });
});
