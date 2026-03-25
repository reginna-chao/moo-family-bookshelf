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
        const result = { encryptionKey: "fake-enc-key-abc" };
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

    // Both books start as 未開放
    const toggleBtns = screen.getAllByText("未開放");
    expect(toggleBtns).toHaveLength(2);

    // Click the first toggle
    fireEvent.click(toggleBtns[0]);

    // First book should now be 開放
    expect(screen.getByText("開放")).toBeInTheDocument();
    expect(screen.getAllByText("未開放")).toHaveLength(1);
  });

  it("save button appears only when dirty", async () => {
    renderPersonalShelf();

    await waitFor(() => {
      expect(screen.getByText("測試書籍一")).toBeInTheDocument();
    });

    // Save button exists but is disabled (not dirty)
    const saveBtn = screen.getByText("儲存變更");
    expect(saveBtn).toBeDisabled();

    // Toggle a book to make it dirty
    const toggleBtns = screen.getAllByText("未開放");
    fireEvent.click(toggleBtns[0]);

    // Save button should now be enabled
    await waitFor(() => {
      expect(screen.getByText("儲存變更")).toBeEnabled();
    });
  });
});
