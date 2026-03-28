import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import type { ApiClient } from "@/api/client";

// Mock crypto module
vi.mock("@/crypto/encrypt", () => ({
  importKey: vi.fn().mockResolvedValue("mock-crypto-key"),
  decrypt: vi.fn().mockImplementation((payload: string) => {
    // Return the payload directly — test data is pre-formatted JSON
    return Promise.resolve(payload);
  }),
}));

// Mock useSearch to avoid debounce complexity in tests
vi.mock("@/dialog/useSearch", () => ({
  useSearch: vi.fn().mockImplementation((items: unknown[]) => ({
    searchTerm: "",
    setSearchTerm: vi.fn(),
    filteredItems: items,
    isFiltering: false,
  })),
}));

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn(),
    updatePersonalBooks: vi.fn(),
    getFamilyMembers: vi.fn(),
    getFamilyBookshelf: vi.fn().mockResolvedValue({ data: { familyId: "fam-1", members: [] } }),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    setAuthToken: vi.fn(),
    hashEmail: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    updateDisplayName: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function makeMemberPayload(displayName: string, books: Array<{ bookId: string; title: string; author: string; isShared: boolean }>) {
  return JSON.stringify({ displayName, books });
}

describe("FamilyShelf", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default chrome.storage.local.get mock — returns encryption key
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = { encryptionKey: "fake-encryption-key" };
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  it("shows loading state initially", () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockReturnValue(new Promise(() => {
        // Never resolves — keeps loading state
      })),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);
    expect(screen.getByText("載入家庭書櫃中...")).toBeInTheDocument();
  });

  it("shows empty state when no books are shared", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", members: [] },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("shows empty state when members have no shared books", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "Book 1", author: "Author", isShared: false },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("renders books when members have shared books", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "共享書籍一", author: "作者A", isShared: true },
                { bookId: "b2", title: "私密書籍", author: "作者B", isShared: false },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("共享書籍一")).toBeInTheDocument();
    });

    // Only shared books should appear
    expect(screen.queryByText("私密書籍")).not.toBeInTheDocument();
    // Total count shows 1
    expect(screen.getByText("(1 本)")).toBeInTheDocument();
  });

  it("shows error state with retry button on API error", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        error: { code: "SERVER_ERROR", message: "伺服器錯誤" },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("伺服器錯誤")).toBeInTheDocument();
      expect(screen.getByText("重試")).toBeInTheDocument();
    });
  });

  it("retry button reloads bookshelf", async () => {
    const getFamilyBookshelf = vi.fn()
      .mockResolvedValueOnce({
        error: { code: "SERVER_ERROR", message: "伺服器錯誤" },
      })
      .mockResolvedValueOnce({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "重試成功書", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      });

    const apiClient = createMockApiClient({ getFamilyBookshelf });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("重試")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("重試"));

    await waitFor(() => {
      expect(screen.getByText("重試成功書")).toBeInTheDocument();
    });

    expect(getFamilyBookshelf).toHaveBeenCalledTimes(2);
  });

  it("shows error state on network exception", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockRejectedValue(new Error("Network failure")),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("Network failure")).toBeInTheDocument();
      expect(screen.getByText("重試")).toBeInTheDocument();
    });
  });

  it("handles member with null payload gracefully", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            { userId: "user-2", payload: null, lastUpdated: null },
            {
              userId: "user-3",
              payload: makeMemberPayload("Bob", [
                { bookId: "b1", title: "Bob的書", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("Bob的書")).toBeInTheDocument();
    });
  });

  it("handles decryption failure gracefully — shows empty books for that member", async () => {
    // Override decrypt to fail for specific payload
    const { decrypt } = await import("@/crypto/encrypt");
    vi.mocked(decrypt).mockRejectedValueOnce(new Error("Decryption failed"));

    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: "corrupted-data",
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-3",
              payload: makeMemberPayload("Carol", [
                { bookId: "b2", title: "Carol的書", author: "C", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("Carol的書")).toBeInTheDocument();
    });
  });

  it("uses userId prefix as display name when displayName is empty", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "abcdefghijklmnop",
              payload: makeMemberPayload("", [
                { bookId: "b1", title: "匿名的書", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      // Should show first 8 chars of userId as member name (appears in dropdown + BookCard)
      const matches = screen.getAllByText("abcdefgh");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders member dropdown for filtering", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "Alice的書", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByLabelText("篩選成員")).toBeInTheDocument();
    });
  });

  it("filters books by selected member", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-1",
              payload: makeMemberPayload("Me", [
                { bookId: "b1", title: "我的書", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b2", title: "Alice的書", author: "B", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      // Default filter is "all-except-self", so "我的書" should NOT appear
      expect(screen.getByText("Alice的書")).toBeInTheDocument();
      expect(screen.queryByText("我的書")).not.toBeInTheDocument();
    });

    // Change filter to "all"
    fireEvent.change(screen.getByLabelText("篩選成員"), { target: { value: "all" } });

    await waitFor(() => {
      expect(screen.getByText("我的書")).toBeInTheDocument();
      expect(screen.getByText("Alice的書")).toBeInTheDocument();
    });
  });

  it("shows total book count in header", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "書一", author: "A", isShared: true },
                { bookId: "b2", title: "書二", author: "B", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("(2 本)")).toBeInTheDocument();
    });
  });

  it("shows search bar when books exist", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "書一", author: "A", isShared: true },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByLabelText("搜尋書名或作者")).toBeInTheDocument();
    });
  });

  it("handles missing encryptionKey in storage gracefully", async () => {
    // Override storage to return no encryption key
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );

    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            { userId: "user-2", payload: "encrypted-data", lastUpdated: "2024-01-01" },
          ],
        },
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    // Should still render without crashing — member gets empty books
    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("handles null data response gracefully", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: null,
      }),
    });

    render(<FamilyShelf familyId="fam-1" userId="user-1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });
});
