import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BOOK_AUTHOR_MAX_LENGTH,
  BOOK_CATEGORY_MAX_LENGTH,
  BOOK_ISBN_MAX_LENGTH,
  BOOK_TEXT_FIELD_LIMITS,
  BOOK_TITLE_MAX_LENGTH,
  exceedsBookFieldCap,
  overCapBookField,
} from "moo-family-bookshelf-shared/api/bookFieldLimits";
import { fitScrapeToFieldCaps, warnFieldCapFit } from "@/sync/fieldCaps";
import { dropResolvedLegacyBooks } from "@/sync/legacyBooks";
import { mergeBooks } from "@/sync/mergeBooks";
import { BoolFlag, type BookEntry } from "@/api/client";
import type { ScrapedBook } from "@/content/scraper";

/**
 * Per-book text caps of `PUT /api/user/:id/books` (#326). The Worker refuses
 * the WHOLE upload with `400 INVALID_PAYLOAD` when one entry's title, author,
 * isbn or category is longer than its cap, so one over-long book on Readmoo
 * used to block every sync. `shared/src/api/bookFieldLimits.ts` holds the caps
 * and the first-over-cap rule both sides use (shared has no test runner, so it
 * is pinned here); `extension/src/sync/fieldCaps.ts` fits a scrape to them
 * before the merge:
 *
 * - a book NOT yet saved with an over-cap field is left out (it is new to the
 *   server, so leaving it out records nothing as removed);
 * - every other NEW book with the same trimmed, non-empty title is held back
 *   with it and counted in `skippedCount` (a lone uploaded twin is what a
 *   saved legacy entry resolves onto when the Personal Shelf loads);
 * - a saved book is never left out — a full PUT without it would record it as
 *   removed and lose its share flag — and each over-cap field takes the saved
 *   value instead, every other field still from the scrape;
 * - a saved book whose scraped title changed to a left-out book's title is
 *   sent with its stored title (counted once in `keptStoredCount`): otherwise
 *   it would be the lone real twin a saved same-title legacy entry resolves
 *   onto at Personal Shelf load, moving that entry's share flag onto it;
 * - a saved book whose stored title IS a left-out book's title and whose
 *   scraped title changed away from it keeps that stored title too: sent with
 *   the new title, it would leave one other real twin on the server, which a
 *   saved same-title legacy entry then resolves onto at Personal Shelf load;
 * - nothing is ever truncated: a cut title would break the same-title
 *   id-change matching that guards 新書預設開放, so a saved value that is
 *   itself over the cap is sent back as it is.
 *
 * `.length` counts UTF-16 code units, like the Worker. The warning carries
 * counts only, never a title or author.
 */

const A = "210000000000101";
const B = "210000000000102";
const C = "210000000000103";

const longText = (length: number) => "長".repeat(length);

function scraped(
  bookId: string,
  overrides: Partial<ScrapedBook> = {},
): ScrapedBook {
  return {
    bookId,
    title: `書${bookId}`,
    author: "作者",
    coverUrl: `https://cdn.readmoo.com/cover/${bookId}.jpg`,
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "小說",
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

function saved(bookId: string, overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId,
    title: `舊書名${bookId}`,
    author: "舊作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "舊分類",
    isShared: BoolFlag.TRUE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

describe("book text-field caps", () => {
  it("pins each cap and the order the Worker reports the first over-cap field in", () => {
    expect(BOOK_TITLE_MAX_LENGTH).toBe(200);
    expect(BOOK_AUTHOR_MAX_LENGTH).toBe(500);
    expect(BOOK_ISBN_MAX_LENGTH).toBe(32);
    expect(BOOK_CATEGORY_MAX_LENGTH).toBe(100);
    expect(BOOK_TEXT_FIELD_LIMITS).toEqual([
      ["title", 200],
      ["author", 500],
      ["isbn", 32],
      ["category", 100],
    ]);
  });
});

describe("exceedsBookFieldCap", () => {
  it.each([
    { name: "a string at the cap", value: "x".repeat(10), over: false },
    { name: "a string one past the cap", value: "x".repeat(11), over: true },
    { name: "an empty string", value: "", over: false },
    // 5 surrogate pairs are 10 UTF-16 units, 6 are 12.
    {
      name: "emoji at the cap in UTF-16 units",
      value: "😀".repeat(5),
      over: false,
    },
    {
      name: "emoji past the cap in UTF-16 units",
      value: "😀".repeat(6),
      over: true,
    },
    { name: "a number", value: 12345678901234, over: false },
    { name: "a long array", value: Array(50).fill("x"), over: false },
    { name: "null", value: null, over: false },
    { name: "undefined", value: undefined, over: false },
  ])("is $over for $name (cap 10)", ({ value, over }) => {
    expect(exceedsBookFieldCap(value, 10)).toBe(over);
  });
});

describe("overCapBookField", () => {
  it("returns null when every field is within its cap", () => {
    expect(
      overCapBookField({
        title: longText(200),
        author: longText(500),
        isbn: "x".repeat(32),
        category: longText(100),
      }),
    ).toBeNull();
    expect(overCapBookField({})).toBeNull();
  });

  it.each([
    { field: "title", max: 200 },
    { field: "author", max: 500 },
    { field: "isbn", max: 32 },
    { field: "category", max: 100 },
  ] as const)("reports $field one character past $max", ({ field, max }) => {
    expect(overCapBookField({ [field]: longText(max + 1) })).toEqual({
      field,
      max,
    });
  });

  it("reports the first over-cap field in title → author → isbn → category order", () => {
    const allOver = {
      category: longText(101),
      isbn: "x".repeat(33),
      author: longText(501),
      title: longText(201),
    };
    expect(overCapBookField(allOver)?.field).toBe("title");
    expect(overCapBookField({ ...allOver, title: "" })?.field).toBe("author");
    expect(overCapBookField({ ...allOver, title: "", author: "" })?.field).toBe(
      "isbn",
    );
    expect(
      overCapBookField({ ...allOver, title: "", author: "", isbn: "" })?.field,
    ).toBe("category");
  });

  it("ignores non-string values however large", () => {
    expect(
      overCapBookField({
        title: Array(500).fill("x"),
        author: 10 ** 600,
        isbn: { length: 999 },
        category: null,
      }),
    ).toBeNull();
  });
});

describe("fitScrapeToFieldCaps", () => {
  it("returns the scrape itself and zero counts when every book fits", () => {
    const books = [scraped(A), scraped(B, { title: longText(200) })];

    const fit = fitScrapeToFieldCaps(books, [saved(A)]);

    expect(fit.books).toBe(books);
    expect(fit.skippedCount).toBe(0);
    expect(fit.skippedTitles).toEqual(new Set());
    expect(fit.keptStoredCount).toBe(0);
  });

  describe("skippedTitles", () => {
    it("holds the trimmed title of each left-out book, never one of a kept-stored book", () => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: "  被略過的書\n", author: longText(501) }),
          scraped(B, { title: "存過的書", author: longText(501) }),
          scraped(C, { title: "放得下的書" }),
        ],
        [saved(B)],
      );

      expect(fit.skippedTitles).toEqual(new Set(["被略過的書"]));
      expect(fit.skippedCount).toBe(1);
      expect(fit.keptStoredCount).toBe(1);
    });

    it("lists a title once when several left-out books carry it", () => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: "同名書", author: longText(501) }),
          scraped(B, { title: " 同名書", category: longText(101) }),
        ],
        [],
      );

      expect(fit.skippedTitles).toEqual(new Set(["同名書"]));
      expect(fit.skippedCount).toBe(2);
    });

    it.each([
      { name: "an empty title", title: "" },
      { name: "a whitespace-only title", title: " \n\t " },
      { name: "a non-string title", title: 42 as unknown as string },
    ])("leaves out $name without listing it", ({ title }) => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title, author: longText(501) }),
          scraped(B, { title: "有書名", author: longText(501) }),
        ],
        [],
      );

      expect(fit.skippedCount).toBe(2);
      // Positive companion: the titled left-out book IS listed.
      expect(fit.skippedTitles).toEqual(new Set(["有書名"]));
    });
  });

  // A lone uploaded twin is what a saved legacy entry resolves onto at Personal Shelf load.
  describe("new books sharing a left-out book's title", () => {
    const D = "210000000000104";

    it.each([
      { name: "the over-cap book comes first", twinFirst: false },
      { name: "the twin comes first in scrape order", twinFirst: true },
    ])(
      "holds back a fitting new twin and counts it when $name",
      ({ twinFirst }) => {
        const overCap = scraped(A, { title: "同名書", author: longText(501) });
        const twin = scraped(B, { title: "  同名書\n" });
        const pair = twinFirst ? [twin, overCap] : [overCap, twin];

        const fit = fitScrapeToFieldCaps([...pair, scraped(C)], []);

        expect(fit.books.map((b) => b.bookId)).toEqual([C]);
        expect(fit.skippedCount).toBe(2);
        expect(fit.skippedTitles).toEqual(new Set(["同名書"]));
        expect(fit.keptStoredCount).toBe(0);
      },
    );

    it("keeps a same-title book that is already saved", () => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: "同名書", author: longText(501) }),
          scraped(B, { title: "同名書" }),
        ],
        [saved(B, { title: "同名書" })],
      );

      expect(fit.books.map((b) => b.bookId)).toEqual([B]);
      expect(fit.skippedCount).toBe(1);
      expect(fit.skippedTitles).toEqual(new Set(["同名書"]));
    });

    it.each([
      { name: "an empty title", title: "" },
      { name: "a whitespace-only title", title: " \n\t " },
    ])("never holds back a new book with $name", ({ title }) => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title, author: longText(501) }),
          scraped(B, { title }),
          scraped(C, { title: "有書名", author: longText(501) }),
          scraped(D, { title: "有書名" }),
        ],
        [],
      );

      expect(fit.books.map((b) => b.bookId)).toEqual([B]);
      // Positive companion: the titled twin D IS held back, so the rule is live.
      expect(fit.skippedCount).toBe(3);
      expect(fit.skippedTitles).toEqual(new Set(["有書名"]));
    });

    it("keeps scrape order and mutates neither input", () => {
      const books = [
        scraped(B, { title: "同名書" }),
        scraped(C),
        scraped(A, { title: "同名書", category: longText(101) }),
        scraped(D, { title: "同名書" }),
      ];
      const savedBooks = [saved(D, { title: "同名書" })];
      const booksBefore = structuredClone(books);
      const savedBefore = structuredClone(savedBooks);

      const fit = fitScrapeToFieldCaps(books, savedBooks);

      expect(fit.books).toEqual([books[1], books[3]]);
      expect(fit.books[0]).toBe(books[1]);
      expect(fit.skippedCount).toBe(2);
      expect(books).toEqual(booksBefore);
      expect(savedBooks).toEqual(savedBefore);
    });
  });

  it.each([
    { field: "title", max: BOOK_TITLE_MAX_LENGTH },
    { field: "author", max: BOOK_AUTHOR_MAX_LENGTH },
    { field: "category", max: BOOK_CATEGORY_MAX_LENGTH },
  ] as const)(
    "fits a $field exactly at its cap ($max) and leaves out a new book one past it",
    ({ field, max }) => {
      const atCap = [scraped(A, { [field]: longText(max) })];
      expect(fitScrapeToFieldCaps(atCap, []).books).toBe(atCap);

      const fit = fitScrapeToFieldCaps(
        [scraped(A), scraped(B, { [field]: longText(max + 1) })],
        [],
      );

      expect(fit.books.map((b) => b.bookId)).toEqual([A]);
      expect(fit.skippedCount).toBe(1);
      expect(fit.keptStoredCount).toBe(0);
    },
  );

  it("keeps a saved book, taking only the over-cap field from the saved entry", () => {
    const book = scraped(A, {
      title: longText(201),
      author: "新作者",
      coverUrl: "https://cdn.readmoo.com/cover/new.jpg",
      category: "新分類",
      isArchived: BoolFlag.TRUE,
    });

    const fit = fitScrapeToFieldCaps([book], [saved(A)]);

    expect(fit.books).toEqual([
      {
        bookId: A,
        title: `舊書名${A}`,
        author: "新作者",
        coverUrl: "https://cdn.readmoo.com/cover/new.jpg",
        readmooUrl: `https://readmoo.com/book/${A}`,
        category: "新分類",
        isArchived: BoolFlag.TRUE,
      },
    ]);
    expect(fit.skippedCount).toBe(0);
    expect(fit.keptStoredCount).toBe(1);
  });

  it("replaces every over-cap field of a saved book, and only those", () => {
    const book = scraped(A, {
      title: longText(201),
      author: "新作者",
      category: longText(101),
    });

    const [fitted] = fitScrapeToFieldCaps([book], [saved(A)]).books;

    expect(fitted.title).toBe(`舊書名${A}`);
    expect(fitted.category).toBe("舊分類");
    expect(fitted.author).toBe("新作者");
  });

  it("sends a saved value that is itself over the cap as it is, never truncated", () => {
    const storedTitle = longText(300);
    const fit = fitScrapeToFieldCaps(
      [scraped(A, { title: longText(250) })],
      [saved(A, { title: storedTitle })],
    );

    expect(fit.books[0].title).toBe(storedTitle);
    expect(fit.books[0].title).toHaveLength(300);
    expect(fit.keptStoredCount).toBe(1);
  });

  it.each([
    { name: "a number", value: 42 },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "an object", value: { zh: "書名" } },
  ])("sends an empty string when the saved value is $name", ({ value }) => {
    const stored = saved(A, { author: value as unknown as string });

    const fit = fitScrapeToFieldCaps(
      [scraped(A, { author: longText(501) })],
      [stored],
    );

    expect(fit.books[0].author).toBe("");
    expect(fit.keptStoredCount).toBe(1);
  });

  it("keeps the scrape order across fitting, left-out and kept books", () => {
    const books = [
      scraped(A, { title: longText(201) }),
      scraped(B, { category: longText(101) }),
      scraped(C),
    ];

    const fit = fitScrapeToFieldCaps(books, [saved(C), saved(A)]);

    expect(fit.books.map((b) => b.bookId)).toEqual([A, C]);
    expect(fit.books[1]).toBe(books[2]);
    expect(fit.skippedCount).toBe(1);
    expect(fit.keptStoredCount).toBe(1);
  });

  it("mutates neither input", () => {
    const books = [
      scraped(A, { title: longText(201) }),
      scraped(B, { author: longText(501) }),
    ];
    const savedBooks = [saved(A)];
    const booksBefore = structuredClone(books);
    const savedBefore = structuredClone(savedBooks);

    const fit = fitScrapeToFieldCaps(books, savedBooks);

    expect(books).toEqual(booksBefore);
    expect(savedBooks).toEqual(savedBefore);
    expect(fit.books).not.toBe(books);
    expect(fit.books[0]).not.toBe(books[0]);
  });
});

// See the header → "a saved book whose scraped title changed to a left-out book's title".
// The sync-level reload regression is in syncUpload.test.ts.
describe("fitScrapeToFieldCaps — a saved book renamed to a left-out book's title", () => {
  const SAME_TITLE = "同名書";
  const STORED_TITLE = "原書名";
  const storedA = () => saved(A, { title: STORED_TITLE });
  const overCapNewB = () =>
    scraped(B, { title: SAME_TITLE, author: longText(501) });

  it.each([
    { name: "the exact title", scrapedTitle: SAME_TITLE },
    {
      name: "the title with surrounding whitespace",
      scrapedTitle: " 同名書\n",
    },
  ])(
    "sends the stored title, every other field from the scrape, when renamed to $name",
    ({ scrapedTitle }) => {
      const renamedA = scraped(A, {
        title: scrapedTitle,
        author: "新作者",
        coverUrl: "https://cdn.readmoo.com/cover/new.jpg",
        category: "新分類",
        isArchived: BoolFlag.TRUE,
      });

      const fit = fitScrapeToFieldCaps([renamedA, overCapNewB()], [storedA()]);

      expect(fit.books).toEqual([
        {
          bookId: A,
          title: STORED_TITLE,
          author: "新作者",
          coverUrl: "https://cdn.readmoo.com/cover/new.jpg",
          readmooUrl: `https://readmoo.com/book/${A}`,
          category: "新分類",
          isArchived: BoolFlag.TRUE,
        },
      ]);
      expect(fit.keptStoredCount).toBe(1);
      expect(fit.skippedCount).toBe(1);
      expect(fit.skippedTitles).toEqual(new Set([SAME_TITLE]));
    },
  );

  it("counts a saved book once when it is also over a cap", () => {
    const renamedA = scraped(A, { title: SAME_TITLE, author: longText(501) });

    const fit = fitScrapeToFieldCaps([renamedA, overCapNewB()], [storedA()]);

    expect(fit.books).toHaveLength(1);
    expect(fit.books[0]).toMatchObject({
      bookId: A,
      title: STORED_TITLE,
      author: "舊作者",
    });
    expect(fit.keptStoredCount).toBe(1);
    expect(fit.skippedCount).toBe(1);
  });

  it("leaves the saved book's title alone when the stored title already is the left-out one", () => {
    const renamedA = scraped(A, { title: SAME_TITLE });

    const fit = fitScrapeToFieldCaps(
      [renamedA, overCapNewB()],
      [saved(A, { title: SAME_TITLE })],
    );

    expect(fit.books.map((b) => [b.bookId, b.title])).toEqual([
      [A, SAME_TITLE],
    ]);
    expect(fit.keptStoredCount).toBe(0);
    expect(fit.skippedCount).toBe(1);
  });

  it.each([
    { name: "every book fits", others: [] as ScrapedBook[], savedOthers: [] },
    {
      name: "the only over-cap new book has another title",
      others: [scraped(B, { title: "別的書", author: longText(501) })],
      savedOthers: [],
    },
    {
      name: "the over-cap same-title book is a saved one",
      others: [scraped(C, { title: SAME_TITLE, author: longText(501) })],
      savedOthers: [saved(C, { title: SAME_TITLE })],
    },
  ])(
    "sends the scraped title of a renamed saved book when $name",
    ({ others, savedOthers }) => {
      const fit = fitScrapeToFieldCaps(
        [scraped(A, { title: SAME_TITLE }), ...others],
        [storedA(), ...savedOthers],
      );

      expect(fit.books.find((b) => b.bookId === A)?.title).toBe(SAME_TITLE);
      expect(fit.skippedTitles.has(SAME_TITLE)).toBe(false);
    },
  );
});

// See the header → "scraped title changed away from it".
describe("fitScrapeToFieldCaps — a saved book renamed away from a left-out book's title", () => {
  const SAME_TITLE = "同名書";
  const NEW_TITLE = "新書名";
  const LEGACY_ID = "14563038";
  const savedList = () => [
    saved(LEGACY_ID, { title: SAME_TITLE, isShared: BoolFlag.TRUE }),
    saved(A, { title: SAME_TITLE, isShared: BoolFlag.FALSE }),
    saved(C, { title: SAME_TITLE, isShared: BoolFlag.FALSE }),
  ];
  const renamedA = () =>
    scraped(A, { title: NEW_TITLE, author: "新作者", category: "新分類" });
  const scrapedC = () => scraped(C, { title: SAME_TITLE });
  const overCapNewB = () =>
    scraped(B, { title: SAME_TITLE, author: longText(501) });

  it("sends the stored title, every other field from the scrape, while a same-title new book is left out", () => {
    const c = scrapedC();

    const fit = fitScrapeToFieldCaps(
      [renamedA(), c, overCapNewB()],
      savedList(),
    );

    expect(fit.books).toEqual([{ ...renamedA(), title: SAME_TITLE }, c]);
    expect(fit.books[1]).toBe(c);
    expect(fit.keptStoredCount).toBe(1);
    expect(fit.skippedCount).toBe(1);
    expect(fit.skippedTitles).toEqual(new Set([SAME_TITLE]));
  });

  it("sends the scraped title when no same-title book is left out (contrast)", () => {
    const fit = fitScrapeToFieldCaps([renamedA(), scrapedC()], savedList());

    expect(fit.books.map((b) => [b.bookId, b.title])).toEqual([
      [A, NEW_TITLE],
      [C, SAME_TITLE],
    ]);
    expect(fit.keptStoredCount).toBe(0);
  });

  it("keeps the shared legacy entry unresolved at the Personal Shelf load", () => {
    const books = savedList();
    const fit = fitScrapeToFieldCaps(
      [renamedA(), scrapedC(), overCapNewB()],
      books,
    );

    const uploaded = mergeBooks(fit.books, books, undefined, fit.skippedTitles);
    // The Personal Shelf load (usePersonalBooks.ts) never sees skippedTitles.
    const reloaded = dropResolvedLegacyBooks(uploaded);

    expect(reloaded.map((b) => [b.bookId, b.title, b.isShared])).toEqual([
      [A, SAME_TITLE, BoolFlag.FALSE],
      [C, SAME_TITLE, BoolFlag.FALSE],
      [LEGACY_ID, SAME_TITLE, BoolFlag.TRUE],
    ]);
  });
});

describe("warnFieldCapFit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nothing when no book was left out or kept with saved values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnFieldCapFit(fitScrapeToFieldCaps([scraped(A)], []));

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a left-out book",
      savedBooks: [] as BookEntry[],
      counts: { skippedCount: 1, keptStoredCount: 0 },
    },
    {
      name: "a book kept with saved values",
      savedBooks: [saved(A)],
      counts: { skippedCount: 0, keptStoredCount: 1 },
    },
  ])(
    "logs one warning with counts only for $name",
    ({ savedBooks, counts }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const secretTitle = `秘密書名${"長".repeat(200)}`;
      const secretAuthor = `秘密作者${"長".repeat(500)}`;

      warnFieldCapFit(
        fitScrapeToFieldCaps(
          [scraped(A, { title: secretTitle, author: secretAuthor })],
          savedBooks,
        ),
      );

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[moo] books over the server's text-field caps",
        counts,
      );
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("秘密");
      expect(logged).not.toContain(A);
    },
  );
});
