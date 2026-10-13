import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag, type BookEntry } from "@/api/client";
import {
  AUTO_SHARE_MAX_NEW,
  autoShareContextFor,
  autoShareNewBooks,
  type AutoShareContext,
} from "@/sync/autoShare";

/**
 * 新書預設開放 (#238, `sync/autoShare.ts`): at sync time, books new to the
 * server are marked shared when the stored setting is on. Sharing a book the
 * user never chose to share is a privacy event, so most cases here pin what is
 * NOT shared: the setting off (only an exact `BoolFlag.TRUE` counts), the first
 * sync, a book the server already holds, a book that is the target of an id
 * change (a renamed book or a resolved legacy short-id entry — an old book under
 * a new id, never a purchase), a book carrying the title of a saved book this
 * scrape did not find (a possible id change that was not paired), an archived
 * book, and a burst of more than
 * `AUTO_SHARE_MAX_NEW` new books (a misread library: nothing is shared, the
 * count is reported, and one counts-only warning is logged).
 *
 * `autoShareNewBooks` is driven with hand-built contexts; `autoShareContextFor`
 * is checked on its own and end-to-end with `autoShareNewBooks` for the legacy
 * resolution case, whose target is derived from the saved and merged lists.
 */

const SERVER_A = "210000000000101";
const SERVER_B = "210000000000102";
const NEW_A = "210000000000201";
const NEW_B = "210000000000202";
const RENAMED_TO = "210000000000301";
const LEGACY_SHORT_ID = "18548672";
const LEGACY_TARGET = "210000000000401";

function book(bookId: string, overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId,
    title: `書${bookId}`,
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

function ctx(
  books: BookEntry[],
  overrides: Partial<AutoShareContext> = {},
): AutoShareContext {
  return {
    enabled: BoolFlag.TRUE,
    firstSync: false,
    scrapedIds: new Set(books.map((b) => b.bookId)),
    serverIds: new Set([SERVER_A, SERVER_B]),
    renamedNewIds: new Set(),
    savedOnlyTitles: new Set(),
    ...overrides,
  };
}

function sharedIds(books: BookEntry[]): string[] {
  return books.filter((b) => b.isShared === BoolFlag.TRUE).map((b) => b.bookId);
}

/** `count` distinct real (15-digit) new book ids. */
function newIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `2109${String(i).padStart(11, "0")}`,
  );
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AUTO_SHARE_MAX_NEW", () => {
  it("is 100 (the user-facing hint and held notice both quote it)", () => {
    expect(AUTO_SHARE_MAX_NEW).toBe(100);
  });
});

describe("autoShareNewBooks", () => {
  it("shares a book that is scraped, new to the server, unshared and active", () => {
    const books = [book(SERVER_A), book(NEW_A)];

    const result = autoShareNewBooks(books, ctx(books));

    expect(sharedIds(result.books)).toEqual([NEW_A]);
    expect(result.autoSharedCount).toBe(1);
    expect(result.autoShareHeldCount).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    { name: "the setting is off", overrides: { enabled: BoolFlag.FALSE } },
    { name: "it is the first sync", overrides: { firstSync: true } },
  ])("returns the same array and zero counts when $name", ({ overrides }) => {
    const books = [book(SERVER_A), book(NEW_A), book(NEW_B)];

    const result = autoShareNewBooks(books, ctx(books, overrides));

    expect(result.books).toBe(books);
    expect(sharedIds(result.books)).toEqual([]);
    expect(result.autoSharedCount).toBe(0);
    expect(result.autoShareHeldCount).toBe(0);
  });

  it.each([
    {
      name: "a book the server already holds",
      entry: book(SERVER_A),
      overrides: {},
    },
    {
      name: "a book already shared",
      entry: book(NEW_A, { isShared: BoolFlag.TRUE }),
      overrides: {},
    },
    {
      name: "the target of a rename",
      entry: book(RENAMED_TO),
      overrides: { renamedNewIds: new Set([RENAMED_TO]) },
    },
    {
      name: "an archived book",
      entry: book(NEW_A, { isArchived: BoolFlag.TRUE }),
      overrides: {},
    },
    {
      name: "a book this scrape did not list",
      entry: book(NEW_A),
      overrides: { scrapedIds: new Set<string>() },
    },
    {
      name: "a book titled like a saved book this scrape did not find",
      entry: book(NEW_A, { title: " 同名書 " }),
      overrides: { savedOnlyTitles: new Set(["同名書"]) },
    },
  ])("leaves $name untouched", ({ entry, overrides }) => {
    const books = [book(SERVER_B), entry];

    const result = autoShareNewBooks(books, ctx(books, overrides));

    expect(result.books).toBe(books);
    expect(result.books[1]).toEqual(entry);
    expect(result.autoSharedCount).toBe(0);
    expect(result.autoShareHeldCount).toBe(0);
  });

  it("shares the new book next to an excluded rename target, never the target", () => {
    const books = [book(SERVER_A), book(RENAMED_TO), book(NEW_A)];

    const result = autoShareNewBooks(
      books,
      ctx(books, { renamedNewIds: new Set([RENAMED_TO]) }),
    );

    // Positive companion: the run DID share something, so the exclusion is not vacuous.
    expect(sharedIds(result.books)).toEqual([NEW_A]);
    expect(result.autoSharedCount).toBe(1);
  });

  it("shares the new book next to one titled like a saved-only book, never that one", () => {
    const books = [
      book(SERVER_A),
      book(NEW_A, { title: "同名書" }),
      book(NEW_B, { title: "別的書" }),
    ];

    const result = autoShareNewBooks(
      books,
      ctx(books, { savedOnlyTitles: new Set(["同名書"]) }),
    );

    expect(sharedIds(result.books)).toEqual([NEW_B]);
    expect(result.autoSharedCount).toBe(1);
  });

  it("shares the new active book next to an excluded archived one, never the archived one", () => {
    const books = [
      book(NEW_A, { isArchived: BoolFlag.TRUE }),
      book(NEW_B, { isArchived: BoolFlag.FALSE }),
    ];

    const result = autoShareNewBooks(books, ctx(books));

    expect(sharedIds(result.books)).toEqual([NEW_B]);
    expect(result.books[0].isShared).toBe(BoolFlag.FALSE);
    expect(result.autoSharedCount).toBe(1);
  });

  it("treats a book with no isArchived field as active", () => {
    const entry = book(NEW_A);
    delete entry.isArchived;
    const books = [entry];

    const result = autoShareNewBooks(books, ctx(books));

    expect(sharedIds(result.books)).toEqual([NEW_A]);
  });

  it("shares all of exactly AUTO_SHARE_MAX_NEW new books", () => {
    const books = newIds(AUTO_SHARE_MAX_NEW).map((id) => book(id));

    const result = autoShareNewBooks(books, ctx(books));

    expect(result.autoSharedCount).toBe(100);
    expect(result.autoShareHeldCount).toBe(0);
    expect(sharedIds(result.books)).toHaveLength(100);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("shares none of AUTO_SHARE_MAX_NEW + 1 new books, reports them held and warns once with counts only", () => {
    const books = newIds(AUTO_SHARE_MAX_NEW + 1).map((id) => book(id));

    const result = autoShareNewBooks(books, ctx(books));

    expect(result.books).toBe(books);
    expect(sharedIds(result.books)).toEqual([]);
    expect(result.autoSharedCount).toBe(0);
    expect(result.autoShareHeldCount).toBe(101);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[moo] auto-share skipped: too many new books",
      { newCount: 101, max: 100 },
    );
  });

  it("counts only NEW books toward the cap (server-held books do not trip it)", () => {
    const fresh = newIds(AUTO_SHARE_MAX_NEW).map((id) => book(id));
    const books = [book(SERVER_A), book(SERVER_B), ...fresh];

    const result = autoShareNewBooks(books, ctx(books));

    expect(result.autoSharedCount).toBe(100);
    expect(result.autoShareHeldCount).toBe(0);
  });

  it("preserves the order and every other field of each book", () => {
    const books = [
      book(NEW_B, { title: "乙" }),
      book(SERVER_A, { isShared: BoolFlag.TRUE }),
      book(NEW_A, { title: "甲", category: "小說" }),
    ];

    const result = autoShareNewBooks(books, ctx(books));

    expect(result.books.map((b) => b.bookId)).toEqual([NEW_B, SERVER_A, NEW_A]);
    expect(result.books[2]).toEqual({
      ...books[2],
      isShared: BoolFlag.TRUE,
    });
    // An untouched book is passed through as-is.
    expect(result.books[1]).toBe(books[1]);
  });

  it("does not mutate the input books or array", () => {
    const books = [book(SERVER_A), book(NEW_A)];
    const snapshot = structuredClone(books);

    const result = autoShareNewBooks(books, ctx(books));

    expect(result.books).not.toBe(books);
    expect(books).toEqual(snapshot);
    expect(books[1].isShared).toBe(BoolFlag.FALSE);
  });
});

describe("autoShareContextFor", () => {
  const scraped = new Set([SERVER_A, NEW_A]);

  it.each([
    { stored: BoolFlag.TRUE, enabled: BoolFlag.TRUE },
    { stored: BoolFlag.FALSE, enabled: BoolFlag.FALSE },
    { stored: undefined, enabled: BoolFlag.FALSE },
    { stored: true, enabled: BoolFlag.FALSE },
    { stored: "1", enabled: BoolFlag.FALSE },
    { stored: 2, enabled: BoolFlag.FALSE },
    { stored: null, enabled: BoolFlag.FALSE },
  ])(
    "reads the stored value $stored as enabled = $enabled (only an exact BoolFlag.TRUE is on)",
    ({ stored, enabled }) => {
      const raw: Record<string, unknown> = { books: [] };
      if (stored !== undefined) raw.newBookDefaultShared = stored;

      const context = autoShareContextFor(
        { books: [book(SERVER_A)], raw },
        [book(SERVER_A), book(NEW_A)],
        [],
        scraped,
      );

      expect(context.enabled).toBe(enabled);
    },
  );

  it.each([
    { name: "there is no record", raw: null, books: [], firstSync: true },
    {
      name: "the record holds no books",
      raw: { newBookDefaultShared: BoolFlag.TRUE },
      books: [],
      firstSync: true,
    },
    {
      name: "the record holds books",
      raw: { newBookDefaultShared: BoolFlag.TRUE },
      books: [book(SERVER_A)],
      firstSync: false,
    },
  ])("sets firstSync = $firstSync when $name", ({ raw, books, firstSync }) => {
    const context = autoShareContextFor({ books, raw }, books, [], scraped);

    expect(context.firstSync).toBe(firstSync);
  });

  it("never auto-shares on a first sync even with the setting on", () => {
    const merged = [book(NEW_A), book(NEW_B)];
    const context = autoShareContextFor(
      { books: [], raw: { newBookDefaultShared: BoolFlag.TRUE } },
      merged,
      [],
      new Set([NEW_A, NEW_B]),
    );

    const result = autoShareNewBooks(merged, context);

    expect(result.books).toBe(merged);
    expect(result.autoSharedCount).toBe(0);
  });

  it("takes the server ids from the saved books and passes the scraped ids through", () => {
    const context = autoShareContextFor(
      { books: [book(SERVER_A), book(SERVER_B)], raw: {} },
      [],
      [],
      scraped,
    );

    expect([...context.serverIds].sort()).toEqual([SERVER_A, SERVER_B]);
    expect(context.scrapedIds).toBe(scraped);
  });

  it("lists each rename's new id as an id-change target", () => {
    const context = autoShareContextFor(
      { books: [book(SERVER_A)], raw: {} },
      [book(SERVER_A)],
      [{ oldId: SERVER_B, newId: RENAMED_TO }],
      scraped,
    );

    expect([...context.renamedNewIds]).toEqual([RENAMED_TO]);
  });

  it("collects the trimmed titles of saved books this scrape did not find, skipping empty ones", () => {
    const context = autoShareContextFor(
      {
        books: [
          book(SERVER_A, { title: "還在的書" }),
          book(SERVER_B, { title: " 不見的書 " }),
          book("210000000000103", { title: "   " }),
        ],
        raw: {},
      },
      [],
      [],
      new Set([SERVER_A]),
    );

    expect([...context.savedOnlyTitles]).toEqual(["不見的書"]);
  });

  it("does not share a new book carrying the title of a saved book this scrape did not find", () => {
    const saved = [book(SERVER_A), book(SERVER_B, { title: "換了編號的書" })];
    // SERVER_B is gone from the scrape and NEW_A carries its title: an unpaired id change.
    const merged = [
      book(SERVER_A),
      book(SERVER_B, { title: "換了編號的書" }),
      book(NEW_A, { title: "換了編號的書" }),
      book(NEW_B),
    ];
    const context = autoShareContextFor(
      { books: saved, raw: { newBookDefaultShared: BoolFlag.TRUE } },
      merged,
      [],
      new Set([SERVER_A, NEW_A, NEW_B]),
    );

    const result = autoShareNewBooks(merged, context);

    expect(sharedIds(result.books)).toEqual([NEW_B]);
  });

  describe("a resolved legacy short-id entry", () => {
    const TITLE = "薩提爾的對話練習";

    function run(
      merged: BookEntry[],
      saved: BookEntry[] = [
        book(SERVER_A),
        book(LEGACY_SHORT_ID, { title: TITLE }),
      ],
    ) {
      const context = autoShareContextFor(
        { books: saved, raw: { newBookDefaultShared: BoolFlag.TRUE } },
        merged,
        [],
        new Set(merged.map((b) => b.bookId)),
      );
      return { context, result: autoShareNewBooks(merged, context) };
    }

    it("treats the real entry carrying the legacy title as an id-change target, not a new book", () => {
      // mergeBooks dropped the legacy entry because it resolved onto LEGACY_TARGET.
      const merged = [
        book(SERVER_A),
        book(LEGACY_TARGET, { title: ` ${TITLE} ` }),
        book(NEW_A),
      ];

      const { context, result } = run(merged);

      expect(context.renamedNewIds.has(LEGACY_TARGET)).toBe(true);
      // Positive companion: the genuinely new book next to it IS shared.
      expect(sharedIds(result.books)).toEqual([NEW_A]);
      expect(result.autoSharedCount).toBe(1);
    });

    it("does not treat a same-title book as a target when the legacy entry is still in the merged list", () => {
      const merged = [
        book(SERVER_A),
        book(LEGACY_SHORT_ID, { title: TITLE }),
        book(NEW_A, { title: TITLE }),
      ];

      const { context } = run(merged);

      expect(context.renamedNewIds.size).toBe(0);
    });

    it("does not match a legacy entry with an empty title", () => {
      const merged = [book(SERVER_A), book(NEW_A, { title: "" })];

      const { context } = run(merged, [
        book(SERVER_A),
        book(LEGACY_SHORT_ID, { title: "  " }),
      ]);

      expect(context.renamedNewIds.size).toBe(0);
    });
  });
});
