import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { BoolFlag, type ApiClient } from "@/api/client";

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
    getFamilyMembers: vi.fn().mockResolvedValue({ data: { familyId: "fam-1", ownerId: "user-1", members: [] } }),
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

function renderWithProvider(
  ui: React.ReactElement,
  apiClient: ApiClient,
  { familyId = "fam-1", userId = "user-1" } = {},
) {
  return render(
    <FamilyDataProvider familyId={familyId} userId={userId} apiClient={apiClient}>
      {ui}
    </FamilyDataProvider>,
  );
}

function makeMemberPayload(displayName: string, books: Array<{ bookId: string; title: string; author: string; isShared: BoolFlag }>) {
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

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);
    expect(screen.getByText("載入家庭書櫃中...")).toBeInTheDocument();
  });

  it("shows empty state when no books are shared", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", members: [] },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("shows empty state when members have no shared books", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "Book 1", author: "Author", isShared: BoolFlag.FALSE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("renders books when members have shared books", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "共享書籍一", author: "作者A", isShared: BoolFlag.TRUE },
                { bookId: "b2", title: "私密書籍", author: "作者B", isShared: BoolFlag.FALSE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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
                { bookId: "b1", title: "重試成功書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      });

    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf,
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("Network failure")).toBeInTheDocument();
      expect(screen.getByText("重試")).toBeInTheDocument();
    });
  });

  it("handles member with null payload gracefully", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [
          { userId: "user-2", displayName: "" },
          { userId: "user-3", displayName: "Bob" },
        ] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            { userId: "user-2", payload: null, lastUpdated: null },
            {
              userId: "user-3",
              payload: makeMemberPayload("Bob", [
                { bookId: "b1", title: "Bob的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("Bob的書")).toBeInTheDocument();
    });
  });

  it("handles decryption failure gracefully — shows empty books for that member", async () => {
    // Override decrypt to fail for specific payload
    const { decrypt } = await import("@/crypto/encrypt");
    vi.mocked(decrypt).mockRejectedValueOnce(new Error("Decryption failed"));

    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [
          { userId: "user-2", displayName: "" },
          { userId: "user-3", displayName: "Carol" },
        ] },
      }),
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
                { bookId: "b2", title: "Carol的書", author: "C", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("Carol的書")).toBeInTheDocument();
    });
  });

  it("uses userId prefix as display name when displayName is empty", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "abcdefghijklmnop", displayName: "" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "abcdefghijklmnop",
              payload: makeMemberPayload("", [
                { bookId: "b1", title: "匿名的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      // Should show first 8 chars of userId as member name (appears in dropdown + BookCard)
      const matches = screen.getAllByText("abcdefgh");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders member dropdown for filtering", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "Alice的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByLabelText("篩選成員")).toBeInTheDocument();
    });
  });

  it("filters books by selected member", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [
          { userId: "user-1", displayName: "Me" },
          { userId: "user-2", displayName: "Alice" },
        ] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-1",
              payload: makeMemberPayload("Me", [
                { bookId: "b1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b2", title: "Alice的書", author: "B", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "書一", author: "A", isShared: BoolFlag.TRUE },
                { bookId: "b2", title: "書二", author: "B", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("(2 本)")).toBeInTheDocument();
    });
  });

  it("shows search bar when books exist", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b1", title: "書一", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

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

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByText("尚無家人分享書籍")).toBeInTheDocument();
    });
  });

  it("updates member display name on chrome.storage.onChanged", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [
          { userId: "user-1", displayName: "小明" },
          { userId: "user-2", displayName: "Alice" },
        ] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-1",
              payload: makeMemberPayload("小明", [
                { bookId: "b1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              payload: makeMemberPayload("Alice", [
                { bookId: "b2", title: "Alice的書", author: "B", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    // Wait for initial load — switch to "all" filter so current user's books are visible
    await waitFor(() => {
      expect(screen.getByText("Alice的書")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("篩選成員"), { target: { value: "all" } });

    await waitFor(() => {
      expect(screen.getByText("我的書")).toBeInTheDocument();
    });

    // Get the listener registered on chrome.storage.onChanged
    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Simulate storage change
    act(() => {
      listener(
        { displayName: { newValue: "新名字", oldValue: "小明" } },
        "local",
      );
    });

    // Verify UI updated — the member name shown on the book card should change
    await waitFor(() => {
      expect(screen.getByText("新名字")).toBeInTheDocument();
    });
  });

  it("ignores chrome.storage.onChanged from non-local area", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-1", displayName: "小明" }] },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-1",
              payload: makeMemberPayload("小明", [
                { bookId: "b1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    await waitFor(() => {
      expect(screen.getByLabelText("篩選成員")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("篩選成員"), { target: { value: "all" } });

    await waitFor(() => {
      expect(screen.getByText("我的書")).toBeInTheDocument();
    });

    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Fire from "sync" area — should be ignored
    act(() => {
      listener(
        { displayName: { newValue: "不應出現", oldValue: "小明" } },
        "sync",
      );
    });

    // The name should still be "小明", not "不應出現"
    expect(screen.queryByText("不應出現")).not.toBeInTheDocument();
  });
});
