import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";
import { FamilyShelfPage } from "@/pages/FamilyShelfPage";
import { FamilyDataProvider } from "@/hooks/useFamilyData";

// Mock API client
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    ApiClient: vi.fn().mockImplementation(() => ({
      getFamilyBookshelf: vi.fn(),
    })),
  };
});

import { BoolFlag, type ApiClient } from "@/api/client";

function makeBooks(
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    isShared: BoolFlag;
    readmooUrl?: string;
  }>,
) {
  return books.map((b) => ({
    bookId: b.bookId,
    title: b.title,
    author: b.author,
    isbn: "",
    coverUrl: "",
    readmooUrl: b.readmooUrl ?? `https://readmoo.com/${b.bookId}`,
    category: "",
    isShared: b.isShared,
  }));
}

const mockGetFamilyBookshelf = vi.fn();
const mockGetFamilyMembers = vi.fn().mockResolvedValue({
  data: { familyId: "fam-1", ownerId: "user-self", members: [] },
});

function createProps() {
  return {
    familyId: "fam-1",
    userId: "user-self",
    apiClient: {
      getFamilyBookshelf: mockGetFamilyBookshelf,
      getFamilyMembers: mockGetFamilyMembers,
    } as unknown as ApiClient,
  };
}

function renderWithProvider(props: ReturnType<typeof createProps>) {
  return render(
    <FamilyDataProvider
      familyId={props.familyId}
      userId={props.userId}
      apiClient={props.apiClient}
    >
      <FamilyShelfPage userId={props.userId} />
    </FamilyDataProvider>,
  );
}

describe("FamilyShelfPage", () => {
  let defaultProps: ReturnType<typeof createProps>;

  beforeEach(() => {
    mockGetFamilyBookshelf.mockReset();
    mockGetFamilyMembers.mockReset();
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [] },
    });
    defaultProps = createProps();
  });

  afterEach(async () => {
    // Flush pending async effects from FamilyDataProvider before cleanup
    await act(async () => {});
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockGetFamilyBookshelf.mockReturnValue(new Promise(() => {})); // never resolves
    mockGetFamilyMembers.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProvider(defaultProps);

    expect(screen.getByText("載入家庭書櫃中...")).toBeInTheDocument();
  });

  it("shows error message and retry button when API fails", async () => {
    mockGetFamilyBookshelf.mockRejectedValue(new Error("Network error"));
    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText("重試")).toBeInTheDocument();
  });

  it("shows error when API returns error response", async () => {
    mockGetFamilyBookshelf.mockResolvedValue({
      error: { code: "NOT_FOUND", message: "找不到家庭群組" },
    });
    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("找不到家庭群組")).toBeInTheDocument();
    });
  });

  it("clicking retry button re-fetches data", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    mockGetFamilyBookshelf.mockRejectedValueOnce(new Error("Network error"));
    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("重試")).toBeInTheDocument();
    });

    // Set up success response for retry
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "Book 1", author: "Author 1", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    fireEvent.click(screen.getByText("重試"));

    await waitFor(() => {
      expect(screen.getByText("Book 1")).toBeInTheDocument();
    });
    expect(mockGetFamilyBookshelf).toHaveBeenCalledTimes(2);
  });

  it("shows empty state when no books are shared", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "Hidden Book", author: "Author", isShared: BoolFlag.FALSE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("shows empty state when members have no books", async () => {
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", displayName: "Alice", books: [], lastUpdated: null },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("renders books after successful load", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "React 深入淺出", author: "作者一", isShared: BoolFlag.TRUE },
              { bookId: "b2", title: "TypeScript 指南", author: "作者二", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("React 深入淺出")).toBeInTheDocument();
    });
    expect(screen.getByText("TypeScript 指南")).toBeInTheDocument();
    expect(screen.getByText("作者一")).toBeInTheDocument();
    expect(screen.getByText("作者二")).toBeInTheDocument();
  });

  it("only renders books with isShared === 1", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "Shared Book", author: "Author", isShared: BoolFlag.TRUE },
              { bookId: "b2", title: "Private Book", author: "Author", isShared: BoolFlag.FALSE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("Shared Book")).toBeInTheDocument();
    });
    expect(screen.queryByText("Private Book")).not.toBeInTheDocument();
  });

  it("default member filter excludes self", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [
        { userId: "user-self", displayName: "Me" },
        { userId: "user-alice", displayName: "Alice" },
      ] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-self",
            displayName: "Me",
            books: makeBooks([
              { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("Alice Book")).toBeInTheDocument();
    });
    // Default filter is "all-except-self", so self's books should not appear
    expect(screen.queryByText("My Book")).not.toBeInTheDocument();
  });

  it("'所有人' filter shows all members including self", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [
        { userId: "user-self", displayName: "Me" },
        { userId: "user-alice", displayName: "Alice" },
      ] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-self",
            displayName: "Me",
            books: makeBooks([
              { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("Alice Book")).toBeInTheDocument();
    });

    // Switch to "所有人"
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "all" },
    });

    await waitFor(() => {
      expect(screen.getByText("My Book")).toBeInTheDocument();
    });
    expect(screen.getByText("Alice Book")).toBeInTheDocument();
  });

  it("search filters books by title", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "React 入門", author: "Author A", isShared: BoolFlag.TRUE },
              { bookId: "b2", title: "Vue 入門", author: "Author B", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("React 入門")).toBeInTheDocument();
    });
    expect(screen.getByText("Vue 入門")).toBeInTheDocument();

    // Switch to fake timers to control debounce
    vi.useFakeTimers();

    // Type in the search box
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

  it("books link to readmooUrl with target _blank", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [{ userId: "user-alice", displayName: "Alice" }] },
    });
    const readmooUrl = "https://readmoo.com/book-123";
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              {
                bookId: "book-123",
                title: "Linked Book",
                author: "Author",
                isShared: BoolFlag.TRUE,
                readmooUrl,
              },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("Linked Book")).toBeInTheDocument();
    });

    const link = screen.getByText("Linked Book").closest("a");
    expect(link).toHaveAttribute("href", readmooUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("updates member display name on displayNameChanged CustomEvent", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [
        { userId: "user-self", displayName: "Me" },
        { userId: "user-alice", displayName: "Alice" },
      ] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-self",
            displayName: "Me",
            books: makeBooks([
              { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    // Wait for data to load
    await waitFor(() => {
      expect(screen.getByText("Alice Book")).toBeInTheDocument();
    });

    // Switch to "all" filter to see self's books
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "all" },
    });

    await waitFor(() => {
      expect(screen.getByText("My Book")).toBeInTheDocument();
    });

    // The current user's display name "Me" appears on their book card
    expect(screen.getByText("Me")).toBeInTheDocument();

    // Dispatch CustomEvent to update display name
    act(() => {
      window.dispatchEvent(
        new CustomEvent("displayNameChanged", { detail: { displayName: "新名字" } }),
      );
    });

    // Verify the current user's name updates
    await waitFor(() => {
      expect(screen.getByText("新名字")).toBeInTheDocument();
    });
    // Old name should be gone
    expect(screen.queryByText("Me")).not.toBeInTheDocument();
  });

  it("shows total book count in header", async () => {
    mockGetFamilyMembers.mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-self", members: [
        { userId: "user-alice", displayName: "Alice" },
        { userId: "user-bob", displayName: "Bob" },
      ] },
    });
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "Book 1", author: "A", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
          {
            userId: "user-bob",
            displayName: "Bob",
            books: makeBooks([
              { bookId: "b2", title: "Book 2", author: "B", isShared: BoolFlag.TRUE },
              { bookId: "b3", title: "Book 3", author: "C", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    });

    renderWithProvider(defaultProps);

    await waitFor(() => {
      expect(screen.getByText("(3 本)")).toBeInTheDocument();
    });
  });

  describe("Load More (Wave G)", () => {
    function makeManyBooks(count: number) {
      return makeBooks(
        Array.from({ length: count }, (_, i) => ({
          bookId: `b${i + 1}`,
          title: `共享書 ${i + 1}`,
          author: `作者${i + 1}`,
          isShared: BoolFlag.TRUE,
        })),
      );
    }

    function setupShelf(bookCount: number) {
      mockGetFamilyMembers.mockResolvedValue({
        data: {
          familyId: "fam-1",
          ownerId: "user-self",
          members: [{ userId: "user-alice", displayName: "Alice" }],
        },
      });
      mockGetFamilyBookshelf.mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-alice",
              displayName: "Alice",
              books: makeManyBooks(bookCount),
              lastUpdated: "2026-01-01",
            },
          ],
        },
      });
    }

    it("shows Load More button when shared books exceed pageSize", async () => {
      setupShelf(250);
      renderWithProvider(defaultProps);

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      expect(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
      ).toBeInTheDocument();
    });

    it("does not show Load More button when books fit in pageSize", async () => {
      setupShelf(80);
      renderWithProvider(defaultProps);

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });

    it("click Load More appends pageSize to visible count", async () => {
      setupShelf(250);
      renderWithProvider(defaultProps);

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 200.*共 250 本/ }),
        ).toBeInTheDocument();
      });
    });

    it("hides Load More button when search narrows the view", async () => {
      setupShelf(250);
      renderWithProvider(defaultProps);

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      // Type in search — narrowingActive becomes true
      fireEvent.change(screen.getByLabelText("搜尋書名或作者"), {
        target: { value: "共享" },
      });

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });
  });
});
