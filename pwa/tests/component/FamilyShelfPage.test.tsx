import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { FamilyShelfPage } from "@/pages/FamilyShelfPage";

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

// Mock crypto
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue("mock-key"),
  decrypt: vi.fn(),
}));

import { decrypt } from "@/crypto/encrypt";
import { BoolFlag, type ApiClient } from "@/api/client";

function makePayload(
  displayName: string,
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    isShared: BoolFlag;
    readmooUrl?: string;
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
      readmooUrl: b.readmooUrl ?? `https://readmoo.com/${b.bookId}`,
      isShared: b.isShared,
    })),
  });
}

const mockDecrypt = vi.mocked(decrypt);
const mockGetFamilyBookshelf = vi.fn();

function createProps() {
  return {
    familyId: "fam-1",
    userId: "user-self",
    apiClient: { getFamilyBookshelf: mockGetFamilyBookshelf } as unknown as ApiClient,
    encryptionKey: "test-key",
  };
}

describe("FamilyShelfPage", () => {
  let defaultProps: ReturnType<typeof createProps>;

  beforeEach(() => {
    mockDecrypt.mockReset();
    mockGetFamilyBookshelf.mockReset();
    defaultProps = createProps();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    mockGetFamilyBookshelf.mockReturnValue(new Promise(() => {})); // never resolves
    render(<FamilyShelfPage {...defaultProps} />);

    expect(screen.getByText("載入家庭書櫃中...")).toBeInTheDocument();
  });

  it("shows error message and retry button when API fails", async () => {
    mockGetFamilyBookshelf.mockRejectedValue(new Error("Network error"));
    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText("重試")).toBeInTheDocument();
  });

  it("shows error when API returns error response", async () => {
    mockGetFamilyBookshelf.mockResolvedValue({
      error: { code: "NOT_FOUND", message: "找不到家庭群組" },
    });
    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("找不到家庭群組")).toBeInTheDocument();
    });
  });

  it("clicking retry button re-fetches data", async () => {
    mockGetFamilyBookshelf.mockRejectedValueOnce(new Error("Network error"));
    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("重試")).toBeInTheDocument();
    });

    // Set up success response for retry
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        { bookId: "b1", title: "Book 1", author: "Author 1", isShared: BoolFlag.TRUE },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
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
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        { bookId: "b1", title: "Hidden Book", author: "Author", isShared: BoolFlag.FALSE },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("shows empty state when members have no payload", async () => {
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: null, lastUpdated: null },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("renders books after successful load and decrypt", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        { bookId: "b1", title: "React 深入淺出", author: "作者一", isShared: BoolFlag.TRUE },
        { bookId: "b2", title: "TypeScript 指南", author: "作者二", isShared: BoolFlag.TRUE },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("React 深入淺出")).toBeInTheDocument();
    });
    expect(screen.getByText("TypeScript 指南")).toBeInTheDocument();
    expect(screen.getByText("作者一")).toBeInTheDocument();
    expect(screen.getByText("作者二")).toBeInTheDocument();
  });

  it("only renders books with isShared === 1", async () => {
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        { bookId: "b1", title: "Shared Book", author: "Author", isShared: BoolFlag.TRUE },
        { bookId: "b2", title: "Private Book", author: "Author", isShared: BoolFlag.FALSE },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Shared Book")).toBeInTheDocument();
    });
    expect(screen.queryByText("Private Book")).not.toBeInTheDocument();
  });

  it("default member filter excludes self", async () => {
    // decrypt is called per member; return different payloads per call
    mockDecrypt
      .mockResolvedValueOnce(
        makePayload("Me", [
          { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
        ]),
      )
      .mockResolvedValueOnce(
        makePayload("Alice", [
          { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
        ]),
      );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-self", payload: "encrypted-self", lastUpdated: "2026-01-01" },
          { userId: "user-alice", payload: "encrypted-alice", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Alice Book")).toBeInTheDocument();
    });
    // Default filter is "all-except-self", so self's books should not appear
    expect(screen.queryByText("My Book")).not.toBeInTheDocument();
  });

  it("'所有人' filter shows all members including self", async () => {
    mockDecrypt
      .mockResolvedValueOnce(
        makePayload("Me", [
          { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
        ]),
      )
      .mockResolvedValueOnce(
        makePayload("Alice", [
          { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
        ]),
      );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-self", payload: "encrypted-self", lastUpdated: "2026-01-01" },
          { userId: "user-alice", payload: "encrypted-alice", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

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
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        { bookId: "b1", title: "React 入門", author: "Author A", isShared: BoolFlag.TRUE },
        { bookId: "b2", title: "Vue 入門", author: "Author B", isShared: BoolFlag.TRUE },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

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
    const readmooUrl = "https://readmoo.com/book-123";
    mockDecrypt.mockResolvedValue(
      makePayload("Alice", [
        {
          bookId: "book-123",
          title: "Linked Book",
          author: "Author",
          isShared: BoolFlag.TRUE,
          readmooUrl,
        },
      ]),
    );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "encrypted", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Linked Book")).toBeInTheDocument();
    });

    const link = screen.getByText("Linked Book").closest("a");
    expect(link).toHaveAttribute("href", readmooUrl);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("updates member display name on displayNameChanged CustomEvent", async () => {
    mockDecrypt
      .mockResolvedValueOnce(
        makePayload("Me", [
          { bookId: "b1", title: "My Book", author: "Self Author", isShared: BoolFlag.TRUE },
        ]),
      )
      .mockResolvedValueOnce(
        makePayload("Alice", [
          { bookId: "b2", title: "Alice Book", author: "Alice Author", isShared: BoolFlag.TRUE },
        ]),
      );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-self", payload: "encrypted-self", lastUpdated: "2026-01-01" },
          { userId: "user-alice", payload: "encrypted-alice", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

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
    mockDecrypt
      .mockResolvedValueOnce(
        makePayload("Alice", [
          { bookId: "b1", title: "Book 1", author: "A", isShared: BoolFlag.TRUE },
        ]),
      )
      .mockResolvedValueOnce(
        makePayload("Bob", [
          { bookId: "b2", title: "Book 2", author: "B", isShared: BoolFlag.TRUE },
          { bookId: "b3", title: "Book 3", author: "C", isShared: BoolFlag.TRUE },
        ]),
      );
    mockGetFamilyBookshelf.mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          { userId: "user-alice", payload: "enc1", lastUpdated: "2026-01-01" },
          { userId: "user-bob", payload: "enc2", lastUpdated: "2026-01-01" },
        ],
      },
    });

    render(<FamilyShelfPage {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("(3 本)")).toBeInTheDocument();
    });
  });
});
