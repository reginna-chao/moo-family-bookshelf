import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { PersonalShelf, PersonalShelfProps } from "@/dialog/PersonalShelf";
import type { ApiClient } from "@/api/client";

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

describe("PersonalShelf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PersonalShelf uses `await chrome.storage.local.get(...)` (promise form)
    // as well as the callback form. Mock to support both patterns.
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

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
      expect(screen.getByText("測試書籍二")).toBeInTheDocument();
    });
  });

  it("toggle button changes text between 開放 and 未開放", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // Both books start as 未開放 (row toggle buttons)
    // Note: the status filter bar also has a "未開放" button, so filter by role
    const toggleBtns = screen.getAllByRole("button", { name: "未開放" });
    // 1 filter button + 2 row toggle buttons = 3 total
    expect(toggleBtns).toHaveLength(3);

    // Click the first ROW toggle (index 1, after the filter button)
    fireEvent.click(toggleBtns[1]);

    // First book should now show 開放
    const openBtns = screen.getAllByRole("button", { name: "開放" });
    expect(openBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("save button appears only when dirty", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // Save button exists but is disabled (not dirty)
    const saveBtn = screen.getByText("儲存變更");
    expect(saveBtn).toBeDisabled();

    // Toggle a book to make it dirty (skip filter button at index 0)
    const toggleBtns = screen.getAllByRole("button", { name: "未開放" });
    fireEvent.click(toggleBtns[1]);

    // Save button should now be enabled
    await waitFor(() => {
      expect(screen.getByText("儲存變更")).toBeEnabled();
    });
  });

  it("renders status filter buttons with 全部 active by default", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // All three filter buttons should be visible
    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已開放" })).toBeInTheDocument();
    // "未開放" appears in both filter bar and row toggles, so use getAllByRole
    const notSharedBtns = screen.getAllByRole("button", { name: "未開放" });
    expect(notSharedBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("filters books by 已開放 status", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // Toggle first book to shared
    const toggleBtns = screen.getAllByRole("button", { name: "未開放" });
    fireEvent.click(toggleBtns[1]); // first row toggle

    // Click 已開放 filter
    fireEvent.click(screen.getByRole("button", { name: "已開放" }));

    // Only the shared book should be visible
    expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    expect(screen.queryByText("測試書籍二")).not.toBeInTheDocument();
  });

  it("filters books by 未開放 status", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // Toggle first book to shared
    const toggleBtns = screen.getAllByRole("button", { name: "未開放" });
    fireEvent.click(toggleBtns[1]); // first row toggle

    // Click 未開放 filter (the filter bar button, not the row toggle)
    const filterBtns = screen.getAllByRole("button", { name: "未開放" });
    fireEvent.click(filterBtns[0]); // filter bar button

    // Only the non-shared book should be visible
    expect(screen.queryByText("測試書籍一")).not.toBeInTheDocument();
    expect(screen.getByText("測試書籍二")).toBeInTheDocument();
  });
});
