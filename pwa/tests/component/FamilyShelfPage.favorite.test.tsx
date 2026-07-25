import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import React from "react";
import { FamilyShelfPage } from "@/pages/FamilyShelfPage";
import { FamilyDataProvider } from "@/hooks/useFamilyData";

/** Walks up from the book title to the nearest card root that holds its overflow trigger. */
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
 * Opens the custom member dropdown and clicks the option whose label matches.
 * Options render as `label + count`, so we match the label substring.
 */
function selectMemberOption(optionLabel: string) {
  fireEvent.click(screen.getByLabelText("篩選成員"));
  const listbox = screen.getByRole("listbox", { name: "成員選單" });
  const option = within(listbox)
    .getAllByRole("option")
    .find((el) => el.textContent?.startsWith(optionLabel));
  if (!option) throw new Error(`member option not found: ${optionLabel}`);
  fireEvent.click(option);
}

/** Switches the member dropdown to the cross-everyone favorites view. */
function enterFavoriteView() {
  selectMemberOption("我的最愛");
}

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
  }>,
) {
  return books.map((b) => ({
    bookId: b.bookId,
    title: b.title,
    author: b.author,
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/${b.bookId}`,
    category: "",
    isShared: b.isShared,
  }));
}

interface MockOpts {
  hidden?: string[];
  favorites?: string[];
  members?: unknown;
  bookshelf?: unknown;
  updateFamilyPrefs?: ReturnType<typeof vi.fn>;
}

function createApiClient(opts: MockOpts = {}) {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: {
        familyShelfPrefs: {
          hidden: opts.hidden ?? [],
          favorites: opts.favorites ?? [],
        },
      },
    }),
    updateFamilyPrefs:
      opts.updateFamilyPrefs ??
      vi
        .fn()
        .mockResolvedValue({ data: { ok: true, hidden: [], favorites: [] } }),
    getFamilyMembers: vi.fn().mockResolvedValue(
      opts.members ?? {
        data: { familyId: "fam-1", ownerId: "user-self", members: [] },
      },
    ),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue(
        opts.bookshelf ?? { data: { familyId: "fam-1", members: [] } },
      ),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    createBorrowRequest: vi.fn(),
  } as unknown as ApiClient;
}

function renderPage(apiClient: ApiClient, userId = "user-self") {
  return render(
    <FamilyDataProvider familyId="fam-1" userId={userId} apiClient={apiClient}>
      <FamilyShelfPage userId={userId} />
    </FamilyDataProvider>,
  );
}

/** Alice with two shared books. */
function aliceTwoBooks() {
  return {
    members: {
      data: {
        familyId: "fam-1",
        ownerId: "user-self",
        members: [{ userId: "user-alice", displayName: "Alice" }],
      },
    },
    bookshelf: {
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
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
            lastUpdated: "2026-01-01",
          },
        ],
      },
    },
  };
}

describe("FamilyShelfPage — favorite feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => {});
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("「我的最愛」view lists ONLY favorited cards across all members", async () => {
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      favorites: ["user-alice:b1"],
    });
    renderPage(apiClient);

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
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-alice:b1"],
      favorites: ["user-alice:b1"],
    });
    renderPage(apiClient);

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
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-alice:b1"],
      favorites: ["user-alice:b1"],
    });
    renderPage(apiClient);

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
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      favorites: ["user-alice:b1"],
    });
    renderPage(apiClient);

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
    const apiClient = createApiClient(aliceTwoBooks());
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

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
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      updateFamilyPrefs,
    });
    renderPage(apiClient);

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
    expect(userIdArg).toBe("user-self");
    expect(prefsArg.favorites).toEqual(["user-alice:b1"]);
    expect(prefsArg.hidden).toEqual([]);
  });

  it("keeps 我的最愛 and 隱藏的書 as distinct views", async () => {
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-alice:b2"],
      favorites: ["user-alice:b1"],
    });
    renderPage(apiClient);

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
    selectMemberOption("隱藏的書");
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
      const apiClient = createApiClient({
        ...aliceTwoBooks(),
        updateFamilyPrefs,
      });
      renderPage(apiClient);

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
