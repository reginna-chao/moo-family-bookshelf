import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { BoolFlag, type ApiClient } from "@/api/client";
import { DISPLAY_NAME_KEY } from "@/constants";


// Mock useSearch to avoid debounce complexity in tests
vi.mock("@/dialog/useSearch", () => ({
  useSearch: vi.fn().mockImplementation((items: unknown[]) => ({
    searchTerm: "",
    setSearchTerm: vi.fn(),
    resetSearch: vi.fn(),
    filteredItems: items,
    isFiltering: false,
  })),
}));

vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

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
    lookupUser: vi.fn(),
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

function makeMemberBooks(books: Array<{ bookId: string; title: string; author: string; isShared: BoolFlag }>) {
  return books;
}

describe("FamilyShelf", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default chrome.storage.local.get mock — returns empty state
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  afterEach(async () => {
    // Flush pending async effects from FamilyDataProvider before cleanup
    await act(async () => {});
  });

  it("shows loading state initially", () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockReturnValue(new Promise(() => {})),
      getFamilyMembers: vi.fn().mockReturnValue(new Promise(() => {})),
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
              displayName: "Alice",
              books: makeMemberBooks([
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
              displayName: "Alice",
              books: makeMemberBooks([
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
              displayName: "Alice",
              books: makeMemberBooks([
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

  it("handles member with null books gracefully", async () => {
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
            { userId: "user-2", displayName: "", books: null, lastUpdated: null },
            {
              userId: "user-3",
              displayName: "Bob",
              books: makeMemberBooks([
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

  it("handles member with empty books gracefully — shows other member's books", async () => {
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
              displayName: "",
              books: [],
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-3",
              displayName: "Carol",
              books: makeMemberBooks([
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
              displayName: "",
              books: makeMemberBooks([
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
              displayName: "Alice",
              books: makeMemberBooks([
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
              displayName: "Me",
              books: makeMemberBooks([
                { bookId: "b1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              displayName: "Alice",
              books: makeMemberBooks([
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
              displayName: "Alice",
              books: makeMemberBooks([
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
              displayName: "Alice",
              books: makeMemberBooks([
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

  it("handles member with empty books array from server", async () => {
    const apiClient = createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          members: [
            { userId: "user-2", displayName: "User2", books: [], lastUpdated: "2024-01-01" },
          ],
        },
      }),
    });

    renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

    // No shared books → empty state
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
              displayName: "小明",
              books: makeMemberBooks([
                { bookId: "b1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              displayName: "Alice",
              books: makeMemberBooks([
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
        { [DISPLAY_NAME_KEY]: { newValue: "新名字", oldValue: "小明" } },
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
              displayName: "小明",
              books: makeMemberBooks([
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
        { [DISPLAY_NAME_KEY]: { newValue: "不應出現", oldValue: "小明" } },
        "sync",
      );
    });

    // The name should still be "小明", not "不應出現"
    expect(screen.queryByText("不應出現")).not.toBeInTheDocument();
  });

  describe("View Mode Toggle (Wave B)", () => {
    function setupWithBooks() {
      return createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
        }),
        getFamilyBookshelf: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            members: [
              {
                userId: "user-2",
                displayName: "Alice",
                books: makeMemberBooks([
                  { bookId: "b1", title: "書一", author: "A", isShared: BoolFlag.TRUE },
                ]),
                lastUpdated: "2024-01-01",
              },
            ],
          },
        }),
      });
    }

    it("renders ViewModeToggle in toolbar", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupWithBooks());
      await waitFor(() => {
        expect(screen.getByRole("group", { name: "家庭書櫃顯示模式" })).toBeInTheDocument();
      });
    });

    it("defaults to grid mode", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupWithBooks());
      await waitFor(() => {
        expect(screen.getByLabelText("切換為網格檢視")).toHaveAttribute("aria-pressed", "true");
      });
    });

    it("switches to row mode on row button click", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupWithBooks());
      await waitFor(() => {
        expect(screen.getByText("書一")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText("切換為列表檢視"));

      await waitFor(() => {
        expect(screen.getByLabelText("切換為列表檢視")).toHaveAttribute("aria-pressed", "true");
      });
    });
  });

  describe("Load More (Wave G)", () => {
    function makeManyBooks(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        bookId: `b${i + 1}`,
        title: `共享書 ${i + 1}`,
        author: `作者${i + 1}`,
        isShared: BoolFlag.TRUE,
      }));
    }

    function setupShelfWithBooks(count: number) {
      return createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: { familyId: "fam-1", ownerId: "user-1", members: [{ userId: "user-2", displayName: "Alice" }] },
        }),
        getFamilyBookshelf: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            members: [
              {
                userId: "user-2",
                displayName: "Alice",
                books: makeManyBooks(count),
                lastUpdated: "2024-01-01",
              },
            ],
          },
        }),
      });
    }

    it("shows Load More button when shared books exceed pageSize", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupShelfWithBooks(250));

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      expect(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
      ).toBeInTheDocument();
    });

    it("does not show Load More button when books fit in pageSize", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupShelfWithBooks(80));

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
    });

    it("click Load More appends pageSize to visible count", async () => {
      renderWithProvider(<FamilyShelf userId="user-1" />, setupShelfWithBooks(250));

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

    it("hides Load More button when search narrows the view (narrowingActive)", async () => {
      const { useSearch } = await import("@/dialog/useSearch");
      const defaultImpl = vi.mocked(useSearch).getMockImplementation();
      vi.mocked(useSearch).mockImplementation((items: unknown[]) => ({
        searchTerm: "共享",
        setSearchTerm: vi.fn(),
        resetSearch: vi.fn(),
        filteredItems: items,
        isFiltering: true,
      }) as ReturnType<typeof useSearch>);

      try {
        renderWithProvider(<FamilyShelf userId="user-1" />, setupShelfWithBooks(250));

        await waitFor(() => {
          expect(screen.getByText("共享書 1")).toBeInTheDocument();
        });

        expect(screen.queryByRole("button", { name: /載入更多/ })).not.toBeInTheDocument();
      } finally {
        if (defaultImpl) vi.mocked(useSearch).mockImplementation(defaultImpl);
      }
    });

    it("resets visibleCount when switching members (Q-B 視角切換類)", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            ownerId: "user-1",
            members: [
              { userId: "user-2", displayName: "Alice" },
              { userId: "user-3", displayName: "Bob" },
            ],
          },
        }),
        getFamilyBookshelf: vi.fn().mockResolvedValue({
          data: {
            familyId: "fam-1",
            members: [
              {
                userId: "user-2",
                displayName: "Alice",
                books: makeManyBooks(250),
                lastUpdated: "2024-01-01",
              },
              {
                userId: "user-3",
                displayName: "Bob",
                books: makeManyBooks(80).map((b, i) => ({ ...b, bookId: `bob-${i}` })),
                lastUpdated: "2024-01-01",
              },
            ],
          },
        }),
      });

      renderWithProvider(<FamilyShelf userId="user-1" />, apiClient);

      await waitFor(() => {
        expect(screen.getByText("共享書 1")).toBeInTheDocument();
      });

      // Load more — 100 → 200 visible
      fireEvent.click(
        screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 330 本/ }),
      );
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 200.*共 330 本/ }),
        ).toBeInTheDocument();
      });

      // Switch member dropdown — should reset visibleCount
      fireEvent.change(screen.getByLabelText("篩選成員"), { target: { value: "user-2" } });

      // Alice has 250 books → after reset, visible = 100
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /載入更多.*已顯示 100.*共 250 本/ }),
        ).toBeInTheDocument();
      });
    });
  });
});
