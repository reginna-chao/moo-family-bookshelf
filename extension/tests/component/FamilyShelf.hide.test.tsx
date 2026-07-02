import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { HIDDEN_FILTER_VALUE } from "@/dialog/MemberDropdown";
import { BoolFlag, type ApiClient } from "@/api/client";

/**
 * Walks up from the book title to the nearest card root that contains its
 * overflow trigger. After the v1.5.0 reshape the title lives in a nested info
 * div while the action row (overflow + favorite) is a sibling, so a plain
 * `.closest("div")` no longer reaches the shared root.
 */
function cardOf(title: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(title);
  while (el) {
    if (within(el).queryByRole("button", { name: "更多選項" })) return el;
    el = el.parentElement;
  }
  throw new Error(`card root not found for ${title}`);
}

/** Opens the overflow menu on the given book's card and clicks its hide/unhide item. */
function triggerHideAction(title: string, itemName: string) {
  const card = cardOf(title);
  fireEvent.click(within(card).getByRole("button", { name: "更多選項" }));
  fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
}

/** Switches the member dropdown to the cross-everyone hidden view. */
function enterHiddenView() {
  fireEvent.change(screen.getByLabelText("篩選成員"), {
    target: { value: HIDDEN_FILTER_VALUE },
  });
}

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

function makeBooks(
  books: Array<{ bookId: string; title: string; author: string; isShared: BoolFlag }>,
) {
  return books;
}

interface MockOpts {
  hidden?: string[];
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
      data: { familyShelfPrefs: { hidden: opts.hidden ?? [] } },
    }),
    updatePersonalBooks: vi.fn(),
    updateFamilyPrefs:
      opts.updateFamilyPrefs ??
      vi.fn().mockResolvedValue({ data: { ok: true, hidden: [] } }),
    getFamilyMembers: vi.fn().mockResolvedValue(
      opts.members ?? {
        data: { familyId: "fam-1", ownerId: "user-1", members: [] },
      },
    ),
    getFamilyBookshelf: vi.fn().mockResolvedValue(
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
    <FamilyDataProvider familyId={familyId} userId={userId} apiClient={apiClient}>
      <FamilyShelf userId={userId} />
    </FamilyDataProvider>,
  );
}

/** Single member (Alice) with two shared books. */
function aliceTwoBooks(members?: Array<{ userId: string; displayName: string }>) {
  return {
    members: {
      data: {
        familyId: "fam-1",
        ownerId: "user-1",
        members: members ?? [{ userId: "user-2", displayName: "Alice" }],
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
              { bookId: "b1", title: "書一", author: "A", isShared: BoolFlag.TRUE },
              { bookId: "b2", title: "書二", author: "B", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2024-01-01",
          },
        ],
      },
    },
  };
}

describe("FamilyShelf — hide feature", () => {
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

  it("hides a book from the default view and updates the heading count", async () => {
    const apiClient = createMockApiClient(aliceTwoBooks());
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    // No hidden yet → only 可見 count, no 隱藏 half.
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();

    // Open 書一's overflow menu and hide it.
    triggerHideAction("書一", "隱藏書籍");

    await waitFor(() => {
      // The first card (書一) is removed from the default view.
      expect(screen.queryByText("書一")).not.toBeInTheDocument();
    });
    // Heading now N-1 / M+1, and the 隱藏 half appears.
    expect(screen.getByText("(可見 1 本，隱藏 1 本)")).toBeInTheDocument();
    expect(screen.getByText("書二")).toBeInTheDocument();
  });

  it("omits the 隱藏 half when M is 0 and shows it once M>0", async () => {
    const apiClient = createMockApiClient(aliceTwoBooks());
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
    });
    expect(screen.queryByText(/隱藏 \d+ 本/)).not.toBeInTheDocument();

    triggerHideAction("書一", "隱藏書籍");

    await waitFor(() => {
      expect(screen.getByText("(可見 1 本，隱藏 1 本)")).toBeInTheDocument();
    });
  });

  it("「隱藏的書」view lists ONLY hidden cards, and 取消隱藏 returns them to default view", async () => {
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-2:b1"],
    });
    renderShelf(apiClient);

    // Default view: b1 hidden, only 書二 visible.
    await waitFor(() => {
      expect(screen.getByText("書二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書一")).not.toBeInTheDocument();
    expect(screen.getByText("(可見 1 本，隱藏 1 本)")).toBeInTheDocument();

    // Switch dropdown to 隱藏的書 → only hidden cards (書一) shown.
    enterHiddenView();

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    expect(screen.queryByText("書二")).not.toBeInTheDocument();

    // 取消隱藏 via overflow menu → 書一 leaves the hidden view.
    triggerHideAction("書一", "取消隱藏");

    await waitFor(() => {
      expect(screen.queryByText("書一")).not.toBeInTheDocument();
    });
    // Heading reflects nothing hidden now.
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
  });

  it("flushes the complete hidden array to updateFamilyPrefs after the debounce", async () => {
    const updateFamilyPrefs = vi
      .fn()
      .mockResolvedValue({ data: { ok: true, hidden: [] } });
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      updateFamilyPrefs,
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    vi.useFakeTimers();
    triggerHideAction("書一", "隱藏書籍");

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();

    expect(updateFamilyPrefs).toHaveBeenCalledTimes(1);
    const [userIdArg, prefsArg] = updateFamilyPrefs.mock.calls[0];
    expect(userIdArg).toBe("user-1");
    expect(prefsArg.hidden).toEqual(["user-2:b1"]);
    // Favorites unaffected by a hide toggle, but still sent in the full-replace flush.
    expect(prefsArg.favorites).toEqual([]);
  });

  it("ignores an orphan hidden ref: counts unaffected, all real cards shown", async () => {
    const apiClient = createMockApiClient({
      ...aliceTwoBooks(),
      hidden: ["ghost-owner:ghost-book"],
    });
    renderShelf(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    // Orphan does not count → N=2, M=0.
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
    expect(screen.getByText("書二")).toBeInTheDocument();
  });

  it("can hide self's own book in the 所有人 view", async () => {
    const members = [
      { userId: "user-1", displayName: "Me" },
      { userId: "user-2", displayName: "Alice" },
    ];
    const apiClient = createMockApiClient({
      members: { data: { familyId: "fam-1", ownerId: "user-1", members } },
      bookshelf: {
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-1",
              displayName: "Me",
              books: makeBooks([
                { bookId: "self-1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
            {
              userId: "user-2",
              displayName: "Alice",
              books: makeBooks([
                { bookId: "b2", title: "Alice的書", author: "B", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2024-01-01",
            },
          ],
        },
      },
    });
    renderShelf(apiClient);

    // Default view excludes self → switch to 所有人 ("all").
    await waitFor(() => {
      expect(screen.getByText("Alice的書")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("篩選成員"), { target: { value: "all" } });

    await waitFor(() => {
      expect(screen.getByText("我的書")).toBeInTheDocument();
    });

    // Hide self's own book via its card's overflow menu.
    triggerHideAction("我的書", "隱藏書籍");

    await waitFor(() => {
      expect(screen.queryByText("我的書")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Alice的書")).toBeInTheDocument();
  });
});
