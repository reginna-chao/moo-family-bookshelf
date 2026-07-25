import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { BoolFlag, type ApiClient } from "@/api/client";

/**
 * Walks up from the book title to the nearest card root that contains its
 * overflow trigger (the shared card root that also holds the heart button).
 */
function cardOf(title: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(title);
  while (el) {
    if (within(el).queryByRole("button", { name: "更多選項" })) return el;
    el = el.parentElement;
  }
  throw new Error(`card root not found for ${title}`);
}

/** Clicks the heart toggle on the given book's card. */
function toggleFavorite(title: string, label: string) {
  const card = cardOf(title);
  fireEvent.click(within(card).getByRole("button", { name: label }));
}

/** Opens the overflow menu on the given book's card and returns the hide/unhide menuitem's label. */
function hideMenuLabelOf(title: string): string {
  const card = cardOf(title);
  fireEvent.click(within(card).getByRole("button", { name: "更多選項" }));
  const item = screen
    .getAllByRole("menuitem")
    .find(
      (el) => el.textContent === "隱藏書籍" || el.textContent === "取消隱藏",
    );
  if (!item) throw new Error(`hide menuitem not found for ${title}`);
  return item.textContent as string;
}

/**
 * Drive the custom MemberDropdown (rewritten from a native `<select>`):
 * open the trigger, then click the option matching `optionName`.
 */
function selectMemberFilter(optionName: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "篩選成員" }));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

/** Switches the member dropdown to the cross-everyone favorites view. */
function enterFavoriteView() {
  selectMemberFilter(/我的最愛/);
}

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

function makeBooks(
  books: Array<{
    bookId: string;
    title: string;
    author: string;
    isShared: BoolFlag;
  }>,
) {
  return books;
}

interface MockOpts {
  hidden?: string[];
  favorites?: string[];
  bookshelf?: unknown;
  members?: unknown;
  updateFamilyPrefs?: ReturnType<typeof vi.fn>;
}

function createMockApiClient(opts: MockOpts = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn(),
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: {
        familyShelfPrefs: {
          hidden: opts.hidden ?? [],
          favorites: opts.favorites ?? [],
        },
      },
    }),
    updatePersonalBooks: vi.fn(),
    updateFamilyPrefs:
      opts.updateFamilyPrefs ??
      vi
        .fn()
        .mockResolvedValue({ data: { ok: true, hidden: [], favorites: [] } }),
    getFamilyMembers: vi.fn().mockResolvedValue(
      opts.members ?? {
        data: { familyId: "fam-1", ownerId: "user-1", members: [] },
      },
    ),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue(
        opts.bookshelf ?? { data: { familyId: "fam-1", members: [] } },
      ),
    getEndpoint: vi.fn().mockReturnValue("https://test.workers.dev"),
    setEndpoint: vi.fn(),
    setAuthToken: vi.fn(),
    lookupUser: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    updateDisplayName: vi.fn(),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    createBorrowRequest: vi.fn(),
  } as unknown as ApiClient;
}

function renderShelf(
  apiClient: ApiClient,
  { familyId = "fam-1", userId = "user-1" } = {},
) {
  return render(
    <FamilyDataProvider
      familyId={familyId}
      userId={userId}
      apiClient={apiClient}
    >
      <FamilyShelf userId={userId} />
    </FamilyDataProvider>,
  );
}

/** Alice with two shared books. */
function aliceTwoBooks() {
  return {
    members: {
      data: {
        familyId: "fam-1",
        ownerId: "user-1",
        members: [{ userId: "user-2", displayName: "Alice" }],
      },
    },
    bookshelf: {
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-2",
            displayName: "Alice",
            books: makeBooks([
              {
                bookId: "b1",
                title: "書一",
                author: "A",
                isShared: BoolFlag.TRUE,
              },
              {
                bookId: "b2",
                title: "書二",
                author: "B",
                isShared: BoolFlag.TRUE,
              },
            ]),
            lastUpdated: "2024-01-01",
          },
        ],
      },
    },
  };
}

describe("FamilyShelf — favorite feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockImplementation(
      (keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
        const result = {};
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result) as unknown as void;
      },
    );
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("「我的最愛」view lists ONLY favorited cards across all members", async () => {
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      favorites: ["user-2:b1"],
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    enterFavoriteView();

    await waitFor(() => {
      expect(screen.getByText("(最愛 1 本)")).toBeInTheDocument();
    });
    expect(screen.getByText("書一")).toBeInTheDocument();
    expect(screen.queryByText("書二")).not.toBeInTheDocument();
  });

  it("shows favorited books INDEPENDENT of hidden status", async () => {
    // b1 is both hidden AND favorited — it must still appear in the favorites view.
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-2:b1"],
      favorites: ["user-2:b1"],
    });
    renderShelf(apiClient);

    // Default view hides b1.
    await waitFor(() => {
      expect(screen.getByText("書二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書一")).not.toBeInTheDocument();

    enterFavoriteView();

    await waitFor(() => {
      expect(screen.getByText("(最愛 1 本)")).toBeInTheDocument();
    });
    // Even though hidden, the favorited b1 shows in the favorites view.
    expect(screen.getByText("書一")).toBeInTheDocument();
    expect(screen.queryByText("書二")).not.toBeInTheDocument();
  });

  it("(W2) shows 取消隱藏 for a hidden+favorited card in the favorites view, per-book", async () => {
    // b1 is BOTH hidden AND favorited. In the favorites view its overflow menu
    // must reflect its per-book hidden state (取消隱藏), not the view-level flag.
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-2:b1"],
      favorites: ["user-2:b1"],
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書二")).toBeInTheDocument();
    });

    enterFavoriteView();

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    // The favorites view is not the hidden view, yet the card is hidden per-book,
    // so the label must be 取消隱藏.
    expect(hideMenuLabelOf("書一")).toBe("取消隱藏");
  });

  it("(W2) shows 隱藏書籍 for a favorited-but-not-hidden card in the favorites view", async () => {
    // b1 is favorited but NOT hidden → the hide label stays 隱藏書籍.
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      favorites: ["user-2:b1"],
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    enterFavoriteView();

    await waitFor(() => {
      expect(screen.getByText("(最愛 1 本)")).toBeInTheDocument();
    });
    expect(hideMenuLabelOf("書一")).toBe("隱藏書籍");
  });

  it("favoriting a book updates the 最愛 heading count in the favorites view", async () => {
    const apiClient = createMockApiClient(aliceTwoBooks());
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    // Favorite 書一 via its heart (default view: heart hollow → 加入最愛).
    toggleFavorite("書一", "加入最愛");

    enterFavoriteView();

    await waitFor(() => {
      expect(screen.getByText("(最愛 1 本)")).toBeInTheDocument();
    });
    expect(screen.getByText("書一")).toBeInTheDocument();
  });

  it("flushes the favorites array (with hidden) to updateFamilyPrefs after the debounce", async () => {
    const updateFamilyPrefs = vi
      .fn()
      .mockResolvedValue({ data: { ok: true, hidden: [], favorites: [] } });
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      updateFamilyPrefs,
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    vi.useFakeTimers();
    toggleFavorite("書一", "加入最愛");

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();

    expect(updateFamilyPrefs).toHaveBeenCalledTimes(1);
    const [userIdArg, prefsArg] = updateFamilyPrefs.mock.calls[0];
    expect(userIdArg).toBe("user-1");
    expect(prefsArg.favorites).toEqual(["user-2:b1"]);
    expect(prefsArg.hidden).toEqual([]);
  });

  it("keeps 我的最愛 and 隱藏的書 as distinct views", async () => {
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-2:b2"],
      favorites: ["user-2:b1"],
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    // Favorites view → only b1.
    enterFavoriteView();
    await waitFor(() => {
      expect(screen.getByText("(最愛 1 本)")).toBeInTheDocument();
    });
    expect(screen.getByText("書一")).toBeInTheDocument();
    expect(screen.queryByText("書二")).not.toBeInTheDocument();

    // Hidden view → only b2.
    selectMemberFilter(/隱藏的書/);
    await waitFor(() => {
      expect(screen.getByText("書二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書一")).not.toBeInTheDocument();
  });

  describe("prefs sync-failed banner (S7)", () => {
    const BANNER_COPY = "⚠️ 偏好同步失敗，變更已暫存本機，下次操作將自動重試。";

    it("is absent initially and appears when a flush fails, then auto-clears on the next success", async () => {
      const updateFamilyPrefs = vi
        .fn()
        .mockResolvedValueOnce({ error: { code: "KABOOM", message: "nope" } })
        .mockResolvedValueOnce({
          data: { ok: true, hidden: [], favorites: [] },
        });
      const apiClient = createMockApiClient({
        ...aliceTwoBooks(),
        updateFamilyPrefs,
      });
      renderShelf(apiClient);

      await waitFor(() => {
        expect(screen.getByText("書一")).toBeInTheDocument();
      });
      // Absent before any flush.
      expect(screen.queryByText(BANNER_COPY)).not.toBeInTheDocument();

      // First flush fails → banner appears.
      vi.useFakeTimers();
      toggleFavorite("書一", "加入最愛");
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      vi.useRealTimers();

      await waitFor(() => {
        const banner = screen.getByText(BANNER_COPY);
        expect(banner).toBeInTheDocument();
        expect(banner).toHaveAttribute("role", "status");
      });

      // Second flush succeeds → banner auto-clears.
      vi.useFakeTimers();
      toggleFavorite("書二", "加入最愛");
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.queryByText(BANNER_COPY)).not.toBeInTheDocument();
      });
    });
  });
});
