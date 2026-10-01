import { describe, it, expect } from "vitest";
import {
  lentBookIdsOf,
  resolveRenamedBooks,
  type RenameContext,
} from "@/sync/renamedBooks";
import {
  BoolFlag,
  BorrowStatus,
  type BookEntry,
  type BorrowRequest,
} from "@/api/client";

/**
 * Id-change resolution (#236). Readmoo occasionally gives a book a new id; the
 * additive merge would then keep the saved OLD id forever next to the scraped
 * NEW one. Only a one-to-one same-title match against a brand-new id counts as
 * a rename — everything else that can explain a missing saved id (archived
 * while archive sync is off, lent, refunded) must keep the old entry.
 */

const OLD_ID = "210000000000001";
const NEW_ID = "210000000000002";
const OTHER_ID = "210000000000003";
const TITLE = "改了編號的書";

function makeBook(overrides: Partial<BookEntry> = {}): BookEntry {
  return {
    bookId: OLD_ID,
    title: TITLE,
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.FALSE,
    isArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

/** Saved-only OLD entry: on the server, absent from the (complete) scrape. */
function oldEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return makeBook({ bookId: OLD_ID, ...overrides });
}

/** Brand-new NEW entry: scraped, never on the server. */
function newEntry(overrides: Partial<BookEntry> = {}): BookEntry {
  return makeBook({ bookId: NEW_ID, ...overrides });
}

function makeCtx(overrides: Partial<RenameContext> = {}): RenameContext {
  return {
    scrapedIds: new Set([NEW_ID]),
    serverIds: new Set([OLD_ID]),
    lentBookIds: new Set(),
    syncArchived: BoolFlag.FALSE,
    ...overrides,
  };
}

function ids(books: readonly BookEntry[]): string[] {
  return books.map((b) => b.bookId);
}

describe("resolveRenamedBooks", () => {
  it("replaces the old entry with its new twin and carries the share flag over", () => {
    const books = [newEntry(), oldEntry({ isShared: BoolFlag.TRUE })];

    const result = resolveRenamedBooks(books, makeCtx());

    expect(result.renamedCount).toBe(1);
    expect(ids(result.books)).toEqual([NEW_ID]);
    expect(result.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("does not flip the new entry to shared when the old one was not shared", () => {
    const books = [newEntry(), oldEntry({ isShared: BoolFlag.FALSE })];

    const result = resolveRenamedBooks(books, makeCtx());

    expect(result.renamedCount).toBe(1);
    expect(ids(result.books)).toEqual([NEW_ID]);
    expect(result.books[0].isShared).toBe(BoolFlag.FALSE);
  });

  it("never clears a target that is already shared", () => {
    const target = newEntry({ isShared: BoolFlag.TRUE });
    const books = [target, oldEntry({ isShared: BoolFlag.FALSE })];

    const result = resolveRenamedBooks(books, makeCtx());

    expect(result.renamedCount).toBe(1);
    expect(result.books[0].isShared).toBe(BoolFlag.TRUE);
    // Nothing to promote → the target entry is reused as-is.
    expect(result.books[0]).toBe(target);
  });

  it("matches titles after trimming surrounding whitespace", () => {
    const books = [
      newEntry({ title: `  ${TITLE}` }),
      oldEntry({ title: `${TITLE} ` }),
    ];

    const result = resolveRenamedBooks(books, makeCtx());

    expect(result.renamedCount).toBe(1);
    expect(ids(result.books)).toEqual([NEW_ID]);
  });

  it("resolves several independent renames in one pass", () => {
    const OLD_2 = "210000000000011";
    const NEW_2 = "210000000000012";
    const books = [
      newEntry(),
      makeBook({ bookId: NEW_2, title: "第二本" }),
      oldEntry({ isShared: BoolFlag.TRUE }),
      makeBook({ bookId: OLD_2, title: "第二本" }),
    ];

    const result = resolveRenamedBooks(
      books,
      makeCtx({
        scrapedIds: new Set([NEW_ID, NEW_2]),
        serverIds: new Set([OLD_ID, OLD_2]),
      }),
    );

    expect(result.renamedCount).toBe(2);
    expect(ids(result.books)).toEqual([NEW_ID, NEW_2]);
    expect(result.books[0].isShared).toBe(BoolFlag.TRUE);
    expect(result.books[1].isShared).toBe(BoolFlag.FALSE);
    expect(result.renamedBooks).toEqual([
      { oldId: OLD_ID, newId: NEW_ID },
      { oldId: OLD_2, newId: NEW_2 },
    ]);
  });

  it("reports each rename as an old→new pair, in the list order of the old entries", () => {
    const OLD_2 = "210000000000011";
    const NEW_2 = "210000000000012";
    // Old entries appear OLD_2 first, then OLD_ID — the opposite of the new ones.
    const books = [
      newEntry(),
      makeBook({ bookId: NEW_2, title: "第二本" }),
      makeBook({ bookId: OLD_2, title: "第二本" }),
      oldEntry(),
    ];

    const result = resolveRenamedBooks(
      books,
      makeCtx({
        scrapedIds: new Set([NEW_ID, NEW_2]),
        serverIds: new Set([OLD_ID, OLD_2]),
      }),
    );

    expect(result.renamedBooks).toEqual([
      { oldId: OLD_2, newId: NEW_2 },
      { oldId: OLD_ID, newId: NEW_ID },
    ]);
    expect(result.renamedCount).toBe(result.renamedBooks.length);
  });

  it("reports a single rename as one pair with a matching count", () => {
    const result = resolveRenamedBooks([newEntry(), oldEntry()], makeCtx());

    expect(result.renamedBooks).toEqual([{ oldId: OLD_ID, newId: NEW_ID }]);
    expect(result.renamedCount).toBe(result.renamedBooks.length);
  });

  /**
   * Every case below must KEEP the old entry — each describes a reason other
   * than an id change for a saved book to be missing, or an ambiguous match.
   */
  const keepCases: Array<{
    name: string;
    books: () => BookEntry[];
    ctx: Partial<RenameContext>;
  }> = [
    {
      name: "the old book is lent out through the app",
      books: () => [newEntry(), oldEntry()],
      ctx: { lentBookIds: new Set([OLD_ID]) },
    },
    {
      name: "the old book is archived while archive sync is off",
      books: () => [newEntry(), oldEntry({ isArchived: BoolFlag.TRUE })],
      ctx: { syncArchived: BoolFlag.FALSE },
    },
    {
      // Owning two editions of the same title: both ids are real books.
      name: "the target id is already on the server",
      books: () => [newEntry(), oldEntry()],
      ctx: { serverIds: new Set([OLD_ID, NEW_ID]) },
    },
    {
      name: "the old id is still in the scrape",
      books: () => [newEntry(), oldEntry()],
      ctx: { scrapedIds: new Set([OLD_ID, NEW_ID]) },
    },
    {
      name: "the old id was never on the server",
      books: () => [newEntry(), oldEntry()],
      ctx: { serverIds: new Set() },
    },
    {
      name: "a third entry carries the same title",
      books: () => [
        newEntry(),
        oldEntry(),
        makeBook({ bookId: OTHER_ID, title: TITLE }),
      ],
      ctx: { serverIds: new Set([OLD_ID, OTHER_ID]) },
    },
    {
      name: "two old entries claim the same new target",
      books: () => [
        newEntry(),
        oldEntry({ isShared: BoolFlag.TRUE }),
        makeBook({ bookId: OTHER_ID, title: TITLE }),
      ],
      ctx: { serverIds: new Set([OLD_ID, OTHER_ID]) },
    },
    {
      name: "the titles are empty",
      books: () => [newEntry({ title: "" }), oldEntry({ title: "" })],
      ctx: {},
    },
    {
      name: "the titles are whitespace only",
      books: () => [newEntry({ title: "  " }), oldEntry({ title: " " })],
      ctx: {},
    },
    {
      name: "the titles differ",
      books: () => [newEntry({ title: "別本書" }), oldEntry()],
      ctx: {},
    },
  ];

  for (const { name, books, ctx } of keepCases) {
    it(`keeps the old entry when ${name}`, () => {
      const input = books();
      const before = input.map((b) => ({ ...b }));

      const result = resolveRenamedBooks(input, makeCtx(ctx));

      expect(result.renamedCount).toBe(0);
      expect(result.renamedBooks).toEqual([]);
      // Nothing replaced → the very same array comes back, untouched.
      expect(result.books).toBe(input);
      expect(input).toEqual(before);
    });
  }

  it("replaces an archived old entry when archive sync is on", () => {
    const books = [
      newEntry({ isArchived: BoolFlag.TRUE }),
      oldEntry({ isArchived: BoolFlag.TRUE, isShared: BoolFlag.TRUE }),
    ];

    const result = resolveRenamedBooks(
      books,
      makeCtx({ syncArchived: BoolFlag.TRUE }),
    );

    expect(result.renamedCount).toBe(1);
    expect(ids(result.books)).toEqual([NEW_ID]);
    expect(result.books[0].isShared).toBe(BoolFlag.TRUE);
  });

  it("is pure: preserves order and leaves its input untouched", () => {
    const unrelatedA = makeBook({ bookId: "210000000000021", title: "甲" });
    const unrelatedB = makeBook({ bookId: "210000000000022", title: "乙" });
    const input = [
      unrelatedA,
      newEntry(),
      oldEntry({ isShared: BoolFlag.TRUE }),
      unrelatedB,
    ];
    const before = input.map((b) => ({ ...b }));

    const result = resolveRenamedBooks(
      input,
      makeCtx({
        scrapedIds: new Set([NEW_ID, unrelatedA.bookId, unrelatedB.bookId]),
        serverIds: new Set([OLD_ID, unrelatedA.bookId, unrelatedB.bookId]),
      }),
    );

    expect(ids(result.books)).toEqual([
      unrelatedA.bookId,
      NEW_ID,
      unrelatedB.bookId,
    ]);
    expect(result.books).not.toBe(input);
    expect(input).toEqual(before);
    // Untouched entries are reused; the promoted target is a new object.
    expect(result.books[0]).toBe(unrelatedA);
    expect(result.books[1]).not.toBe(input[1]);
  });
});

describe("lentBookIdsOf", () => {
  const OWNER = "user-owner";

  function makeRequest(overrides: Partial<BorrowRequest>): BorrowRequest {
    return {
      requestId: "req",
      familyId: "fam-1",
      borrowerId: "user-borrower",
      borrowerName: "借書人",
      ownerId: OWNER,
      bookId: "210000000000099",
      bookTitle: "書",
      bookAuthor: "",
      bookCoverUrl: "",
      status: BorrowStatus.LENT,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("collects only LENT requests where the user is the lender", () => {
    const requests = [
      makeRequest({ bookId: "210000000000101" }),
      makeRequest({ bookId: "210000000000102", ownerId: "someone-else" }),
      makeRequest({ bookId: "210000000000103", status: BorrowStatus.PENDING }),
      makeRequest({ bookId: "210000000000104", status: BorrowStatus.RETURNED }),
      makeRequest({ bookId: "210000000000105", status: BorrowStatus.REJECTED }),
      makeRequest({
        bookId: "210000000000106",
        status: BorrowStatus.CANCELLED,
      }),
      makeRequest({
        bookId: "210000000000107",
        ownerId: "someone-else",
        borrowerId: OWNER,
      }),
    ];

    expect([...lentBookIdsOf(requests, OWNER)]).toEqual(["210000000000101"]);
  });

  it("returns an empty set for no requests", () => {
    expect(lentBookIdsOf([], OWNER).size).toBe(0);
  });
});
