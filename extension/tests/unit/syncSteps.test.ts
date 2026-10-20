import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The DOM scraper is the only boundary replaced here.
vi.mock("@/content/scraper", () => ({
  scrapeLibrary: vi.fn(),
  scrapeArchivedBooks: vi.fn(),
}));

import {
  fetchBorrowRequestsForSync,
  holdBackRenameCandidates,
  resolveForUpload,
  scrapeForSync,
  type SyncScrape,
} from "@/sync/syncSteps";
import { scrapeLibrary, scrapeArchivedBooks } from "@/content/scraper";
import {
  BoolFlag,
  BorrowStatus,
  type ApiClient,
  type BookEntry,
  type BorrowRequest,
} from "@/api/client";
import { SYNC_ARCHIVED_KEY } from "@/constants";

const LIB_BOOK = {
  bookId: "210000000000001",
  title: "在架書",
  author: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isArchived: BoolFlag.FALSE,
};
const ARCH_BOOK = {
  ...LIB_BOOK,
  bookId: "210000000000002",
  isArchived: BoolFlag.TRUE,
};

describe("scrapeForSync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    vi.mocked(scrapeLibrary).mockResolvedValue({
      books: [LIB_BOOK],
      complete: true,
      libraryIds: null,
    });
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("skips the archive when 同步封存書 is off: library completeness only, archive not covered", async () => {
    const result = await scrapeForSync();

    expect(scrapeArchivedBooks).not.toHaveBeenCalled();
    expect(result).toEqual({
      books: [LIB_BOOK],
      complete: true,
      libraryIds: null,
      syncArchived: BoolFlag.FALSE,
      archiveCovered: false,
    });
  });

  it("carries the library pass's library ids, never the archive pass's", async () => {
    const libraryIds = new Set([LIB_BOOK.bookId, ARCH_BOOK.bookId]);
    await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
    vi.mocked(scrapeLibrary).mockResolvedValue({
      books: [LIB_BOOK],
      complete: true,
      libraryIds,
    });
    vi.mocked(scrapeArchivedBooks).mockResolvedValue({
      books: [ARCH_BOOK],
      complete: true,
      libraryIds: new Set([ARCH_BOOK.bookId]),
    });

    const result = await scrapeForSync();

    expect(result.libraryIds).toBe(libraryIds);
    expect(result.books).toEqual([LIB_BOOK, ARCH_BOOK]);
  });

  it.each([
    { archiveComplete: true, complete: true, archiveCovered: true },
    { archiveComplete: false, complete: false, archiveCovered: false },
  ])(
    "with 同步封存書 on, archive complete=$archiveComplete → complete=$complete, covered=$archiveCovered",
    async ({ archiveComplete, complete, archiveCovered }) => {
      await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
      vi.mocked(scrapeArchivedBooks).mockResolvedValue({
        books: archiveComplete ? [ARCH_BOOK] : [],
        complete: archiveComplete,
        libraryIds: null,
      });

      const result = await scrapeForSync();

      expect(scrapeArchivedBooks).toHaveBeenCalledTimes(1);
      expect(result.complete).toBe(complete);
      expect(result.archiveCovered).toBe(archiveCovered);
      expect(result.syncArchived).toBe(BoolFlag.TRUE);
    },
  );

  it("is incomplete when the library scrape is, even with a complete archive", async () => {
    await chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });
    vi.mocked(scrapeLibrary).mockResolvedValue({
      books: [],
      complete: false,
      libraryIds: null,
    });
    vi.mocked(scrapeArchivedBooks).mockResolvedValue({
      books: [ARCH_BOOK],
      complete: true,
      libraryIds: null,
    });

    const result = await scrapeForSync();

    expect(result.complete).toBe(false);
    // The archive itself was fully read.
    expect(result.archiveCovered).toBe(true);
  });
});

describe("fetchBorrowRequestsForSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the family's borrow list", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const api = { listBorrowRequests: list } as unknown as ApiClient;

    await expect(fetchBorrowRequestsForSync(api, "fam-1")).resolves.toEqual([]);
    expect(list).toHaveBeenCalledWith("fam-1");
  });

  it("returns null (not an empty list) when the fetch fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = {
      listBorrowRequests: vi.fn().mockRejectedValue(new Error("down")),
    } as unknown as ApiClient;

    await expect(fetchBorrowRequestsForSync(api, "fam-1")).resolves.toBeNull();
  });
});

describe("resolveForUpload", () => {
  const OLD_ID = "210000000000011";
  const NEW_ID = "210000000000012";
  const USER_ID = "user-1";
  const saved: BookEntry = {
    bookId: OLD_ID,
    title: "改了編號的書",
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
    isArchived: BoolFlag.FALSE,
  };
  const scraped = { ...LIB_BOOK, bookId: NEW_ID, title: saved.title };
  const merged: BookEntry[] = [
    { ...saved, bookId: NEW_ID, isShared: BoolFlag.FALSE },
    saved,
  ];
  // The pre-scrape read held the same list every case passes as `savedBooks`.
  const SAVED_IDS: ReadonlySet<string> = new Set([OLD_ID]);

  function scrapeOf(
    complete: boolean,
    libraryIds: ReadonlySet<string> | null = null,
  ): SyncScrape {
    return {
      books: [scraped],
      complete,
      libraryIds,
      syncArchived: BoolFlag.FALSE,
      archiveCovered: false,
    };
  }

  /** OLD (shared) is gone from Readmoo: the scrape and the library ids hold only an unrelated NEW book. */
  function goneFromReadmoo(complete: boolean): {
    list: BookEntry[];
    scrape: SyncScrape;
  } {
    const unrelated = { ...LIB_BOOK, bookId: NEW_ID, title: "別的書" };
    return {
      list: [
        { ...saved, bookId: NEW_ID, title: "別的書", isShared: BoolFlag.FALSE },
        saved,
      ],
      scrape: {
        ...scrapeOf(complete, new Set([NEW_ID])),
        books: [unrelated],
      },
    };
  }

  function lentOld(bookId = OLD_ID): BorrowRequest {
    return {
      requestId: "req-1",
      familyId: "fam-1",
      borrowerId: "user-2",
      borrowerName: "借書人",
      ownerId: USER_ID,
      bookId,
      bookTitle: "書",
      bookAuthor: "",
      bookCoverUrl: "",
      status: BorrowStatus.LENT,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("reports the rename pair on a complete scrape with a known borrow list", () => {
    const result = resolveForUpload(merged, scrapeOf(true), [saved], [], {
      familyId: "fam-1",
      userId: USER_ID,
      preScrapeServerIds: SAVED_IDS,
    });

    expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID]);
    expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
    expect(result.renamedCount).toBe(1);
  });

  it("resolves without a family even though no borrow list was fetched", () => {
    const result = resolveForUpload(merged, scrapeOf(true), [saved], null, {
      userId: USER_ID,
      preScrapeServerIds: SAVED_IDS,
    });

    expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
  });

  it("reports deferredCount 0 on the judging path", () => {
    const result = resolveForUpload(merged, scrapeOf(true), [saved], [], {
      familyId: "fam-1",
      userId: USER_ID,
      preScrapeServerIds: SAVED_IDS,
    });

    expect(result.deferredCount).toBe(0);
  });

  const cannotJudge = [
    {
      name: "the scrape is incomplete",
      complete: false,
      requests: [] as BorrowRequest[] | null,
    },
    {
      name: "the family's borrow list is unavailable",
      complete: true,
      requests: null,
    },
  ];

  describe.each(cannotJudge)("when $name", ({ complete, requests }) => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("renames nothing and holds back the brand-new same-title entry", () => {
      const result = resolveForUpload(
        merged,
        scrapeOf(complete),
        [saved],
        requests,
        { familyId: "fam-1", userId: USER_ID, preScrapeServerIds: SAVED_IDS },
      );

      // The OLD id stays (it may still be real); the NEW twin is not uploaded,
      // so a later sync that can judge still sees it as brand-new.
      expect(result).toEqual({
        books: [saved],
        renamedBooks: [],
        renamedCount: 0,
        deferredCount: 1,
        removedBooks: [],
        removedCount: 0,
        removedSharedCount: 0,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[moo] renames cannot be judged this sync; held back possible renamed books",
        { deferredCount: 1 },
      );
    });

    it("uploads the merged list itself (same reference) when nothing is a candidate", () => {
      const unrelated = { ...LIB_BOOK, bookId: NEW_ID, title: "別的書" };
      const plain: BookEntry[] = [
        { ...saved, bookId: NEW_ID, title: "別的書", isShared: BoolFlag.FALSE },
        saved,
      ];
      const result = resolveForUpload(
        plain,
        { ...scrapeOf(complete), books: [unrelated] },
        [saved],
        requests,
        { familyId: "fam-1", userId: USER_ID, preScrapeServerIds: SAVED_IDS },
      );

      expect(result).toEqual({
        books: plain,
        renamedBooks: [],
        renamedCount: 0,
        deferredCount: 0,
        removedBooks: [],
        removedCount: 0,
        removedSharedCount: 0,
      });
      expect(result.books).toBe(plain);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("prunes nothing even when Readmoo's library no longer holds a saved book", () => {
      const { list, scrape } = goneFromReadmoo(complete);

      const result = resolveForUpload(list, scrape, [saved], requests, {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      });

      expect(result.books).toBe(list);
      expect(result.removedBooks).toEqual([]);
      expect(result.removedCount).toBe(0);
      expect(result.removedSharedCount).toBe(0);
    });
  });

  // #241: pruning runs only where renames are judged, after them.
  describe("pruning", () => {
    it("removes a saved book Readmoo no longer holds on a complete scrape with a known borrow list", () => {
      const { list, scrape } = goneFromReadmoo(true);

      const result = resolveForUpload(list, scrape, [saved], [], {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      });

      expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID]);
      expect(result.removedBooks).toEqual([
        { bookId: OLD_ID, isShared: BoolFlag.TRUE },
      ]);
      expect(result.removedCount).toBe(1);
      expect(result.removedSharedCount).toBe(1);
      expect(result.renamedBooks).toEqual([]);
      expect(result.deferredCount).toBe(0);
    });

    it("also prunes without a family (no borrow list needed)", () => {
      const { list, scrape } = goneFromReadmoo(true);

      const result = resolveForUpload(list, scrape, [saved], null, {
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      });

      expect(result.removedCount).toBe(1);
    });

    it("prunes nothing when the library ids are unknown", () => {
      const { list, scrape } = goneFromReadmoo(true);

      const result = resolveForUpload(
        list,
        { ...scrape, libraryIds: null },
        [saved],
        [],
        { familyId: "fam-1", userId: USER_ID, preScrapeServerIds: SAVED_IDS },
      );

      expect(result.books).toBe(list);
      expect(result.removedCount).toBe(0);
    });

    it("keeps a saved book the user has lent out through MooFamily", () => {
      const { list, scrape } = goneFromReadmoo(true);

      const result = resolveForUpload(list, scrape, [saved], [lentOld()], {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      });

      expect(result.books).toBe(list);
      expect(result.removedCount).toBe(0);
    });

    it("prunes a book lent through MooFamily by SOMEONE ELSE (only the owner's loans shield)", () => {
      const { list, scrape } = goneFromReadmoo(true);
      const othersLoan = { ...lentOld(), ownerId: "user-9" };

      const result = resolveForUpload(list, scrape, [saved], [othersLoan], {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      });

      expect(result.removedBooks.map((b) => b.bookId)).toEqual([OLD_ID]);
    });

    it.each([
      { syncArchived: BoolFlag.FALSE, books: [NEW_ID, OLD_ID], removed: [] },
      { syncArchived: BoolFlag.TRUE, books: [NEW_ID], removed: [OLD_ID] },
    ])(
      "passes the scrape's 同步封存書 setting (syncArchived=$syncArchived) to pruning for an archived saved book",
      ({ syncArchived, books, removed }) => {
        const { list, scrape } = goneFromReadmoo(true);
        const archivedSaved = { ...saved, isArchived: BoolFlag.TRUE };
        const archivedList = [list[0], archivedSaved];

        const result = resolveForUpload(
          archivedList,
          { ...scrape, syncArchived },
          [archivedSaved],
          [],
          { familyId: "fam-1", userId: USER_ID, preScrapeServerIds: SAVED_IDS },
        );

        expect(result.books.map((b) => b.bookId)).toEqual(books);
        expect(result.removedBooks.map((b) => b.bookId)).toEqual(removed);
      },
    );

    it("reports an old id paired by a rename as renamed, not removed", () => {
      // NEW is the same-title twin of OLD; Readmoo's library lists NEW only.
      const result = resolveForUpload(
        merged,
        scrapeOf(true, new Set([NEW_ID])),
        [saved],
        [],
        { familyId: "fam-1", userId: USER_ID, preScrapeServerIds: SAVED_IDS },
      );

      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID]);
      expect(result.removedBooks).toEqual([]);
      expect(result.removedCount).toBe(0);
    });

    // The race fixed in #241: another device stored OLD after this sync's pre-scrape read.
    it("keeps a saved book the pre-scrape read did not hold, even though Readmoo lacks it", () => {
      const { list, scrape } = goneFromReadmoo(true);

      const result = resolveForUpload(list, scrape, [saved], [], {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: new Set<string>(),
      });

      expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID, OLD_ID]);
      expect(result.books[1].isShared).toBe(BoolFlag.TRUE);
      expect(result.removedBooks).toEqual([]);
      expect(result.removedCount).toBe(0);
      expect(result.removedSharedCount).toBe(0);
    });

    it("still judges renames against the current read, not the pre-scrape ids", () => {
      // OLD is only in the current read; its same-title NEW twin still pairs with it.
      const result = resolveForUpload(
        merged,
        scrapeOf(true, new Set([NEW_ID])),
        [saved],
        [],
        {
          familyId: "fam-1",
          userId: USER_ID,
          preScrapeServerIds: new Set<string>(),
        },
      );

      expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
      expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID]);
    });
  });

  it("keeps a lent old id and reports no rename", () => {
    const result = resolveForUpload(
      merged,
      scrapeOf(true),
      [saved],
      [lentOld()],
      {
        familyId: "fam-1",
        userId: USER_ID,
        preScrapeServerIds: SAVED_IDS,
      },
    );

    expect(result.renamedBooks).toEqual([]);
    expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID, OLD_ID]);
  });

  // #326: a title in `skippedTitles` is a scraped book the field-cap fit left out of `merged`.
  describe("skippedTitles", () => {
    const options = {
      familyId: "fam-1",
      userId: USER_ID,
      preScrapeServerIds: SAVED_IDS,
    };

    it("does not pair a same-title rename while another scraped copy of the title was left out", () => {
      const result = resolveForUpload(merged, scrapeOf(true), [saved], [], {
        ...options,
        skippedTitles: new Set([saved.title]),
      });

      expect(result.renamedBooks).toEqual([]);
      expect(result.books.map((b) => b.bookId)).toEqual([NEW_ID, OLD_ID]);
      expect(result.books[1].isShared).toBe(BoolFlag.TRUE);
    });

    it.each([
      { name: "keeps", skippedTitles: new Set([saved.title]), kept: [OLD_ID] },
      {
        name: "prunes (positive companion)",
        skippedTitles: undefined,
        kept: [],
      },
    ])(
      "$name a saved book whose left-out scraped twin Readmoo's library holds",
      ({ skippedTitles, kept }) => {
        // NEW (the twin, title T) is in the scrape and library ids but not in `merged`.
        const result = resolveForUpload(
          [saved],
          scrapeOf(true, new Set([NEW_ID])),
          [saved],
          [],
          { ...options, skippedTitles },
        );

        expect(result.books.map((b) => b.bookId)).toEqual(kept);
        expect(result.removedCount).toBe(1 - kept.length);
        expect(result.renamedBooks).toEqual([]);
      },
    );
  });
});

// The onboarding sync (`dialog/onboardingBooksUpload.ts`) never judges renames and
// calls this directly with the scrape's ids and the saved list.
describe("holdBackRenameCandidates", () => {
  const OLD_ID = "210000000000021";
  const NEW_ID = "210000000000022";
  const book = (bookId: string, title: string): BookEntry => ({
    bookId,
    title,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
  });
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("derives server ids from the saved list and warns with the count only", () => {
    const old = book(OLD_ID, "同名書");
    const result = holdBackRenameCandidates(
      [book(NEW_ID, "同名書"), old],
      new Set([NEW_ID]),
      [old],
    );

    expect(result).toEqual({ books: [old], deferredCount: 1 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, detail] = warnSpy.mock.calls[0] as [string, unknown];
    // Count only: no ids, no titles in the log.
    expect(detail).toEqual({ deferredCount: 1 });
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain(NEW_ID);
    expect(JSON.stringify(warnSpy.mock.calls[0])).not.toContain("同名書");
  });

  it("is silent and returns the same array when nothing is held back", () => {
    const merged = [book(NEW_ID, "新書"), book(OLD_ID, "舊書")];

    const result = holdBackRenameCandidates(merged, new Set([NEW_ID]), [
      book(OLD_ID, "舊書"),
    ]);

    expect(result.books).toBe(merged);
    expect(result.deferredCount).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
