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
import {
  OVER_CAP_TITLE_PLACEHOLDER,
  fitScrapeToFieldCaps,
  warnFieldCapFit,
} from "@/sync/fieldCaps";
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
 * - a book NOT yet saved whose TITLE is over the cap is left out (it is new to
 *   the server, so leaving it out records nothing as removed) and counted in
 *   `skippedCount`; its trimmed, non-empty title goes into `skippedTitles`;
 * - any other new book is uploaded, each over-cap author or category sent as
 *   `""` while the title and every other field stay as scraped, counted once
 *   per book in `blankedCount` (neither field takes part in same-title
 *   matching, and a missing book is worse than a missing author);
 * - a saved book is never left out — a full PUT without it would record it as
 *   removed and lose its share flag — and each over-cap author or category
 *   takes the saved value instead, sent as it is even when itself over the cap,
 *   every other field still from the scrape (`keptStoredCount`);
 * - a saved book's over-cap title is sent as saved when unchanged (`titleKey`
 *   equal — only a pre-cap title can be, and the Worker admits it), and
 *   otherwise replaced by `OVER_CAP_TITLE_PLACEHOLDER`. Nothing is truncated:
 *   a 200-unit cut could equal a legacy entry's exact 200-unit title (and the
 *   stored title could equal another book's), and same-title matching would
 *   then move that entry's share flag onto the renamed book. Only saved books
 *   carry the placeholder, so same-title matching never pairs on it.
 *
 * Same-title books: no new book is ever held back for sharing a title, and no
 * saved book's scraped title is ever reverted to its stored one. An earlier
 * rule did both, and each variant could leave a saved legacy (short-id) entry
 * with ONE real same-title twin on the server, which the Personal Shelf load
 * (`dropResolvedLegacyBooks`) then resolved onto, moving the legacy share flag
 * to a book the user never chose. The "same-title books" group replays the
 * three reported scenarios and checks that load. Because the Worker accepts no
 * new over-cap title, a left-out title equals no stored one; `skippedTitles`
 * only matters for titles saved before the caps existed (the "pre-cap" case).
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
    const books = [
      scraped(A),
      scraped(B, {
        title: longText(BOOK_TITLE_MAX_LENGTH),
        author: longText(BOOK_AUTHOR_MAX_LENGTH),
        category: longText(BOOK_CATEGORY_MAX_LENGTH),
      }),
    ];

    const fit = fitScrapeToFieldCaps(books, [saved(A)]);

    expect(fit.books).toBe(books);
    expect(fit).toMatchObject({
      skippedCount: 0,
      blankedCount: 0,
      keptStoredCount: 0,
    });
    expect(fit.skippedTitles).toEqual(new Set());
  });

  describe("a new book", () => {
    it.each([
      { field: "title", max: BOOK_TITLE_MAX_LENGTH },
      { field: "author", max: BOOK_AUTHOR_MAX_LENGTH },
      { field: "category", max: BOOK_CATEGORY_MAX_LENGTH },
    ] as const)(
      "fits a $field exactly at its cap ($max) unchanged",
      ({ field, max }) => {
        const atCap = [scraped(A, { [field]: longText(max) })];

        expect(fitScrapeToFieldCaps(atCap, []).books).toBe(atCap);
      },
    );

    it("leaves out a new book whose title is one past the cap, listing that title", () => {
      const overTitle = longText(BOOK_TITLE_MAX_LENGTH + 1);

      const fit = fitScrapeToFieldCaps(
        [scraped(A), scraped(B, { title: overTitle })],
        [],
      );

      expect(fit.books.map((b) => b.bookId)).toEqual([A]);
      expect(fit.skippedCount).toBe(1);
      expect(fit.skippedTitles).toEqual(new Set([overTitle]));
      expect(fit.blankedCount).toBe(0);
      expect(fit.keptStoredCount).toBe(0);
    });

    it.each([
      { field: "author", max: BOOK_AUTHOR_MAX_LENGTH },
      { field: "category", max: BOOK_CATEGORY_MAX_LENGTH },
    ] as const)(
      "uploads a new book whose $field is one past $max with that field blank, every other field intact",
      ({ field, max }) => {
        const book = scraped(B, { [field]: longText(max + 1) });

        const fit = fitScrapeToFieldCaps([scraped(A), book], []);

        expect(fit.books).toEqual([scraped(A), { ...book, [field]: "" }]);
        expect(fit.blankedCount).toBe(1);
        expect(fit.skippedCount).toBe(0);
        expect(fit.skippedTitles).toEqual(new Set());
        expect(fit.keptStoredCount).toBe(0);
      },
    );

    it("blanks both an over-cap author and an over-cap category, counting the book once", () => {
      const book = scraped(A, {
        author: longText(BOOK_AUTHOR_MAX_LENGTH + 1),
        category: longText(BOOK_CATEGORY_MAX_LENGTH + 1),
      });

      const fit = fitScrapeToFieldCaps([book], []);

      expect(fit.books).toEqual([{ ...book, author: "", category: "" }]);
      expect(fit.blankedCount).toBe(1);
      expect(fit.skippedCount).toBe(0);
    });

    it("counts each blanked book once", () => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { author: longText(BOOK_AUTHOR_MAX_LENGTH + 1) }),
          scraped(B, { category: longText(BOOK_CATEGORY_MAX_LENGTH + 1) }),
          scraped(C),
        ],
        [],
      );

      expect(fit.books.map((b) => [b.bookId, b.author, b.category])).toEqual([
        [A, "", "小說"],
        [B, "作者", ""],
        [C, "作者", "小說"],
      ]);
      expect(fit.blankedCount).toBe(2);
    });

    it("leaves out a new book whose title is over the cap even when its author is too, blanking nothing", () => {
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, {
            title: longText(BOOK_TITLE_MAX_LENGTH + 1),
            author: longText(BOOK_AUTHOR_MAX_LENGTH + 1),
          }),
        ],
        [],
      );

      expect(fit.books).toEqual([]);
      expect(fit.skippedCount).toBe(1);
      expect(fit.blankedCount).toBe(0);
    });
  });

  describe("skippedTitles", () => {
    it("holds the trimmed title of each left-out book, never one of a blanked or kept-stored book", () => {
      const leftOutTitle = longText(BOOK_TITLE_MAX_LENGTH + 1);
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: `  ${leftOutTitle}\n` }),
          scraped(B, { title: "存".repeat(BOOK_TITLE_MAX_LENGTH + 1) }),
          scraped(C, {
            title: "作者太長的書",
            author: longText(BOOK_AUTHOR_MAX_LENGTH + 1),
          }),
        ],
        [saved(B)],
      );

      expect(fit.skippedTitles).toEqual(new Set([leftOutTitle]));
      expect(fit.skippedCount).toBe(1);
      expect(fit.blankedCount).toBe(1);
      expect(fit.keptStoredCount).toBe(1);
    });

    it("lists a title once when several left-out books carry it", () => {
      const leftOutTitle = longText(BOOK_TITLE_MAX_LENGTH + 1);
      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: leftOutTitle }),
          scraped(B, { title: ` ${leftOutTitle}` }),
        ],
        [],
      );

      expect(fit.skippedTitles).toEqual(new Set([leftOutTitle]));
      expect(fit.skippedCount).toBe(2);
    });

    it.each([
      { name: "an empty title", title: "" },
      { name: "a short whitespace-only title", title: " \n\t " },
      { name: "a non-string title", title: 42 as unknown as string },
    ])(
      "uploads a new book with $name, which is never over the title cap",
      ({ title }) => {
        const book = scraped(A, {
          title,
          author: longText(BOOK_AUTHOR_MAX_LENGTH + 1),
        });

        const fit = fitScrapeToFieldCaps([book], []);

        expect(fit.books).toEqual([{ ...book, author: "" }]);
        expect(fit.skippedCount).toBe(0);
        expect(fit.skippedTitles).toEqual(new Set());
        expect(fit.blankedCount).toBe(1);
      },
    );

    it("leaves out a whitespace-only title past the cap without listing it", () => {
      const leftOutTitle = longText(BOOK_TITLE_MAX_LENGTH + 1);

      const fit = fitScrapeToFieldCaps(
        [
          scraped(A, { title: " ".repeat(BOOK_TITLE_MAX_LENGTH + 1) }),
          scraped(B, { title: leftOutTitle }),
        ],
        [],
      );

      expect(fit.skippedCount).toBe(2);
      // Positive companion: the titled left-out book IS listed.
      expect(fit.skippedTitles).toEqual(new Set([leftOutTitle]));
    });
  });

  it("keeps a saved book, replacing only its changed over-cap title with the placeholder", () => {
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
        title: OVER_CAP_TITLE_PLACEHOLDER,
        author: "新作者",
        coverUrl: "https://cdn.readmoo.com/cover/new.jpg",
        readmooUrl: `https://readmoo.com/book/${A}`,
        category: "新分類",
        isArchived: BoolFlag.TRUE,
      },
    ]);
    expect(fit.skippedCount).toBe(0);
    expect(fit.blankedCount).toBe(0);
    expect(fit.keptStoredCount).toBe(1);
  });

  it("fits every over-cap field of a saved book, and only those", () => {
    const book = scraped(A, {
      title: longText(201),
      author: "新作者",
      category: longText(101),
    });

    const [fitted] = fitScrapeToFieldCaps([book], [saved(A)]).books;

    expect(fitted.title).toBe(OVER_CAP_TITLE_PLACEHOLDER);
    expect(fitted.category).toBe("舊分類");
    expect(fitted.author).toBe("新作者");
  });

  it("gives a saved book its saved author, but a new book a blank one", () => {
    const overAuthor = longText(BOOK_AUTHOR_MAX_LENGTH + 1);

    const fit = fitScrapeToFieldCaps(
      [scraped(A, { author: overAuthor }), scraped(B, { author: overAuthor })],
      [saved(A)],
    );

    expect(fit.books.map((b) => [b.bookId, b.author])).toEqual([
      [A, "舊作者"],
      [B, ""],
    ]);
    expect(fit.keptStoredCount).toBe(1);
    expect(fit.blankedCount).toBe(1);
  });

  it("sends an unchanged pre-cap title that is itself over the cap as stored, never truncated", () => {
    const storedTitle = longText(300);
    const fit = fitScrapeToFieldCaps(
      [scraped(A, { title: longText(300) })],
      [saved(A, { title: storedTitle })],
    );

    expect(fit.books[0].title).toBe(storedTitle);
    expect(fit.books[0].title).toHaveLength(300);
    expect(fit.keptStoredCount).toBe(1);
  });

  it("sends the stored over-cap title verbatim when the scrape differs from it only by surrounding whitespace", () => {
    const storedTitle = ` ${longText(250)}\n`;
    const fit = fitScrapeToFieldCaps(
      [scraped(A, { title: `\t${longText(250)}  ` })],
      [saved(A, { title: storedTitle })],
    );

    expect(fit.books[0].title).toBe(storedTitle);
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
    expect(fit.blankedCount).toBe(0);
  });

  it("keeps the scrape order across left-out, blanked, kept-stored and fitting books", () => {
    const D = "210000000000104";
    const books = [
      scraped(A, { title: longText(201) }),
      scraped(B, { author: longText(501) }),
      scraped(C, { title: "丙".repeat(201) }),
      scraped(D),
    ];

    const fit = fitScrapeToFieldCaps(books, [saved(C)]);

    expect(fit.books.map((b) => b.bookId)).toEqual([B, C, D]);
    expect(fit.books[0]).toEqual({ ...books[1], author: "" });
    expect(fit.books[1].title).toBe(OVER_CAP_TITLE_PLACEHOLDER);
    expect(fit.books[2]).toBe(books[3]);
    expect(fit).toMatchObject({
      skippedCount: 1,
      blankedCount: 1,
      keptStoredCount: 1,
    });
  });

  it("mutates neither input", () => {
    const books = [
      scraped(A, { title: longText(201) }),
      scraped(B, { author: longText(501) }),
      scraped(C, { category: longText(101) }),
    ];
    const savedBooks = [saved(A)];
    const booksBefore = structuredClone(books);
    const savedBefore = structuredClone(savedBooks);

    const fit = fitScrapeToFieldCaps(books, savedBooks);

    expect(books).toEqual(booksBefore);
    expect(savedBooks).toEqual(savedBefore);
    expect(fit.books).not.toBe(books);
    fit.books.forEach((book, i) => expect(book).not.toBe(books[i]));
  });
});

// See the header → "Same-title books". The sync-level replays are in syncUpload.test.ts.
describe("fitScrapeToFieldCaps — same-title books", () => {
  const SAME_TITLE = "同名書";
  const STORED_TITLE = "原書名";
  const LEGACY_ID = "14563038";
  const overAuthor = longText(BOOK_AUTHOR_MAX_LENGTH + 1);
  const rows = (books: BookEntry[]) =>
    books.map((b) => [b.bookId, b.title, b.isShared]);

  /** The upload a sync builds from `fit`, then the Personal Shelf load's rule on it. */
  function uploadedThenReloaded(
    fit: ReturnType<typeof fitScrapeToFieldCaps>,
    savedBooks: BookEntry[],
  ) {
    const uploaded = mergeBooks(
      fit.books,
      savedBooks,
      undefined,
      fit.skippedTitles,
    );
    // usePersonalBooks.ts never sees skippedTitles.
    return { uploaded, reloaded: dropResolvedLegacyBooks(uploaded) };
  }

  it("uploads both new twins of a shared legacy entry, so it stays unresolved (scenario 1)", () => {
    const savedBooks = [
      saved(LEGACY_ID, { title: SAME_TITLE, isShared: BoolFlag.TRUE }),
    ];
    const y = scraped(A, { title: SAME_TITLE });
    const z = scraped(B, { title: SAME_TITLE, author: overAuthor });

    const fit = fitScrapeToFieldCaps([y, z], savedBooks);

    expect(fit.books).toEqual([y, { ...z, author: "" }]);
    expect(fit.books[0]).toBe(y);
    expect(fit).toMatchObject({
      skippedCount: 0,
      blankedCount: 1,
      keptStoredCount: 0,
    });
    expect(fit.skippedTitles).toEqual(new Set());
    const { uploaded, reloaded } = uploadedThenReloaded(fit, savedBooks);
    const expected = [
      [A, SAME_TITLE, BoolFlag.FALSE],
      [B, SAME_TITLE, BoolFlag.FALSE],
      [LEGACY_ID, SAME_TITLE, BoolFlag.TRUE],
    ];
    expect(rows(uploaded)).toEqual(expected);
    expect(rows(reloaded)).toEqual(expected);
  });

  it("sends a saved book renamed to a blanked book's title with its new title (scenario 2)", () => {
    const savedBooks = [
      saved(LEGACY_ID, { title: STORED_TITLE, isShared: BoolFlag.TRUE }),
      saved(A, { title: STORED_TITLE, isShared: BoolFlag.FALSE }),
    ];
    const renamedA = scraped(A, { title: SAME_TITLE, author: "新作者" });
    const b = scraped(B, { title: SAME_TITLE, author: overAuthor });

    const fit = fitScrapeToFieldCaps([renamedA, b], savedBooks);

    expect(fit.books).toEqual([renamedA, { ...b, author: "" }]);
    expect(fit.books[0]).toBe(renamedA);
    expect(fit.keptStoredCount).toBe(0);
    expect(fit.blankedCount).toBe(1);
    const { reloaded } = uploadedThenReloaded(fit, savedBooks);
    expect(rows(reloaded)).toEqual([
      [A, SAME_TITLE, BoolFlag.FALSE],
      [B, SAME_TITLE, BoolFlag.FALSE],
      [LEGACY_ID, STORED_TITLE, BoolFlag.TRUE],
    ]);
  });

  it("sends two saved books renamed apart with their new titles (scenario 3)", () => {
    const savedBooks = [
      saved(LEGACY_ID, { title: STORED_TITLE, isShared: BoolFlag.TRUE }),
      saved(A, { title: STORED_TITLE, isShared: BoolFlag.FALSE }),
      saved(C, { title: STORED_TITLE, isShared: BoolFlag.FALSE }),
    ];
    const renamedA = scraped(A, { title: SAME_TITLE });
    const renamedC = scraped(C, { title: "另一書名" });
    const b = scraped(B, { title: SAME_TITLE, author: overAuthor });

    const fit = fitScrapeToFieldCaps([renamedA, renamedC, b], savedBooks);

    expect(fit.books).toEqual([renamedA, renamedC, { ...b, author: "" }]);
    expect(fit.keptStoredCount).toBe(0);
    expect(fit.blankedCount).toBe(1);
    const { reloaded } = uploadedThenReloaded(fit, savedBooks);
    expect(rows(reloaded)).toEqual([
      [A, SAME_TITLE, BoolFlag.FALSE],
      [C, "另一書名", BoolFlag.FALSE],
      [B, SAME_TITLE, BoolFlag.FALSE],
      [LEGACY_ID, STORED_TITLE, BoolFlag.TRUE],
    ]);
  });

  it.each([
    {
      name: "an over-cap title, sent as the placeholder",
      newTitle: longText(BOOK_TITLE_MAX_LENGTH + 1),
      sentTitle: OVER_CAP_TITLE_PLACEHOLDER,
      keptStoredCount: 1,
    },
    {
      name: "a title that fits, sent as scraped",
      newTitle: SAME_TITLE,
      sentTitle: SAME_TITLE,
      keptStoredCount: 0,
    },
  ])(
    "leaves a shared legacy entry alone when a same-title saved book is renamed to $name",
    ({ newTitle, sentTitle, keptStoredCount }) => {
      const savedBooks = [
        saved(LEGACY_ID, { title: STORED_TITLE, isShared: BoolFlag.TRUE }),
        saved(A, { title: STORED_TITLE, isShared: BoolFlag.FALSE }),
        saved(C, { title: STORED_TITLE, isShared: BoolFlag.FALSE }),
      ];

      const fit = fitScrapeToFieldCaps(
        [scraped(A, { title: newTitle }), scraped(C, { title: "另一書名" })],
        savedBooks,
      );

      expect(fit.books.map((b) => [b.bookId, b.title])).toEqual([
        [A, sentTitle],
        [C, "另一書名"],
      ]);
      expect(fit.keptStoredCount).toBe(keptStoredCount);
      const { reloaded } = uploadedThenReloaded(fit, savedBooks);
      expect(rows(reloaded)).toEqual([
        [A, sentTitle, BoolFlag.FALSE],
        [C, "另一書名", BoolFlag.FALSE],
        [LEGACY_ID, STORED_TITLE, BoolFlag.TRUE],
      ]);
    },
  );

  // Mutation: with a 200-unit cut A was sent titled exactly T, and the legacy entry resolved onto A.
  it("never sends a renamed saved book with a cut equal to a legacy entry's 200-unit title", () => {
    const legacyTitle = "a".repeat(BOOK_TITLE_MAX_LENGTH);
    const savedBooks = [
      saved(LEGACY_ID, { title: legacyTitle, isShared: BoolFlag.TRUE }),
      saved(A, { title: "Original", isShared: BoolFlag.FALSE }),
    ];

    const fit = fitScrapeToFieldCaps(
      [scraped(A, { title: `${legacyTitle}suffix` })],
      savedBooks,
    );

    expect(fit.books.map((b) => [b.bookId, b.title])).toEqual([
      [A, OVER_CAP_TITLE_PLACEHOLDER],
    ]);
    expect(fit.books[0].title).not.toBe(legacyTitle);
    const { reloaded } = uploadedThenReloaded(fit, savedBooks);
    expect(rows(reloaded)).toEqual([
      [A, OVER_CAP_TITLE_PLACEHOLDER, BoolFlag.FALSE],
      [LEGACY_ID, legacyTitle, BoolFlag.TRUE],
    ]);
    // Positive companion: A sent titled T instead takes the legacy entry's share flag.
    const cut = [{ ...fit.books[0], title: legacyTitle }];
    expect(
      rows(uploadedThenReloaded({ ...fit, books: cut }, savedBooks).reloaded),
    ).toEqual([[A, legacyTitle, BoolFlag.TRUE]]);
  });

  // See the header → "the "pre-cap" case": a title stored before the caps existed.
  it("lists a left-out title a pre-cap saved book still carries, keeping its legacy entry unresolved", () => {
    const preCapTitle = longText(BOOK_TITLE_MAX_LENGTH + 1);
    const savedBooks = [
      saved(LEGACY_ID, { title: preCapTitle, isShared: BoolFlag.TRUE }),
      saved(A, { title: preCapTitle, isShared: BoolFlag.FALSE }),
    ];

    const fit = fitScrapeToFieldCaps(
      [scraped(A, { title: preCapTitle }), scraped(B, { title: preCapTitle })],
      savedBooks,
    );

    expect(fit.books.map((b) => [b.bookId, b.title])).toEqual([
      [A, preCapTitle],
    ]);
    expect(fit.skippedTitles).toEqual(new Set([preCapTitle]));
    const kept = mergeBooks(
      fit.books,
      savedBooks,
      undefined,
      fit.skippedTitles,
    );
    expect(rows(kept)).toEqual([
      [A, preCapTitle, BoolFlag.FALSE],
      [LEGACY_ID, preCapTitle, BoolFlag.TRUE],
    ]);
    // Positive companion: without skippedTitles the legacy entry resolves onto A.
    expect(rows(mergeBooks(fit.books, savedBooks))).toEqual([
      [A, preCapTitle, BoolFlag.TRUE],
    ]);
  });
});

describe("warnFieldCapFit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const CAP_WARNING = "[moo] books over the server's text-field caps";
  const secretTitle = `秘密書名${"長".repeat(200)}`;
  const secretAuthor = `秘密作者${"長".repeat(500)}`;

  it("logs nothing when no book was left out, blanked or kept with saved values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnFieldCapFit(fitScrapeToFieldCaps([scraped(A)], []));

    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a left-out book",
      book: scraped(A, { title: secretTitle }),
      savedBooks: [] as BookEntry[],
      counts: { skippedCount: 1, blankedCount: 0, keptStoredCount: 0 },
    },
    {
      name: "a blanked book",
      book: scraped(A, { title: "秘密書名", author: secretAuthor }),
      savedBooks: [] as BookEntry[],
      counts: { skippedCount: 0, blankedCount: 1, keptStoredCount: 0 },
    },
    {
      name: "a book kept with saved values",
      book: scraped(A, { title: secretTitle, author: secretAuthor }),
      savedBooks: [saved(A)],
      counts: { skippedCount: 0, blankedCount: 0, keptStoredCount: 1 },
    },
  ])(
    "logs one warning with counts only for $name",
    ({ book, savedBooks, counts }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      warnFieldCapFit(fitScrapeToFieldCaps([book], savedBooks));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(CAP_WARNING, counts);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("秘密");
      expect(logged).not.toContain(A);
    },
  );

  it("reports all three counts in the one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnFieldCapFit(
      fitScrapeToFieldCaps(
        [
          scraped(A, { title: secretTitle }),
          scraped(B, { author: secretAuthor }),
          scraped(C, { author: secretAuthor }),
        ],
        [saved(C)],
      ),
    );

    expect(warn.mock.calls).toEqual([
      [CAP_WARNING, { skippedCount: 1, blankedCount: 1, keptStoredCount: 1 }],
    ]);
  });
});
