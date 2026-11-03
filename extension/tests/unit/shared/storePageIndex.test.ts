import { describe, it, expect } from "vitest";
import {
  buildStorePageIndex,
  formatStoreChipText,
  formatStoreStaleText,
  isStoreIndexFresh,
  lookupStoreChipNames,
  MAX_STORE_INDEX_BOOKS,
  MAX_STORE_INDEX_NAME_LENGTH,
  parseStorePageIndex,
  STORE_INDEX_FUTURE_TOLERANCE_MS,
  STORE_INDEX_MAX_AGE_DAYS,
  STORE_INDEX_MAX_AGE_MS,
  STORE_INDEX_VERSION,
  type StoreIndexMember,
  type StorePageIndex,
} from "moo-family-bookshelf-shared/storePage/index";
import {
  READMOO_STORE_BOOK_URL_BASE,
  READMOO_STORE_MATCH_PATTERNS,
  READMOO_STORE_SELECTORS,
  storeBookIdFromPath,
} from "moo-family-bookshelf-shared/config/readmooStore";
import { isAllowedBookUrl } from "moo-family-bookshelf-shared/config/readmoo";

/**
 * Store-page chip index (#313, shared/src/storePage/index.ts) and the store-page config
 * (shared/src/config/readmooStore.ts). `shared/` has no test script, so its behaviour is covered here.
 *
 * The index is built by the Dialog from the family shelf it already holds and read back on a Readmoo
 * store page from extension storage, which the page cannot vouch for: `parseStorePageIndex` therefore
 * rejects the WHOLE index on any malformed field (the store page then shows no chip), and only own,
 * real-book-id keys are accepted — a `__proto__` key parsed from JSON is an own key and must be refused,
 * not inherited. The viewer's own books never get a chip, so the builder drops the viewer's entry.
 */

const VIEWER = "viewer-user-id";
const FAMILY = "family-id-1";
const BOOK_A = "210000000000001";
const BOOK_B = "210000000000002";
const NOW = new Date("2026-11-02T03:04:05.000Z");

function member(
  userId: string,
  displayName: string,
  bookIds: string[],
): StoreIndexMember {
  return { userId, displayName, books: bookIds.map((bookId) => ({ bookId })) };
}

function validIndex(books: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 2,
    viewerUserId: VIEWER,
    familyId: FAMILY,
    updatedAt: NOW.toISOString(),
    books,
  };
}

describe("buildStorePageIndex", () => {
  it("stamps the version, viewer, family and build time", () => {
    const index = buildStorePageIndex([], VIEWER, FAMILY, NOW);

    expect(STORE_INDEX_VERSION).toBe(2);
    expect(index).toEqual({
      version: STORE_INDEX_VERSION,
      viewerUserId: VIEWER,
      familyId: FAMILY,
      updatedAt: "2026-11-02T03:04:05.000Z",
      books: {},
    });
  });

  it("leaves out the viewer's own books", () => {
    const index = buildStorePageIndex(
      [member(VIEWER, "Me", [BOOK_A]), member("user-2", "Bob", [BOOK_B])],
      VIEWER,
      FAMILY,
      NOW,
    );

    expect(index.books).toEqual({ [BOOK_B]: ["Bob"] });
  });

  it("skips every book id that is not a real Readmoo id", () => {
    const index = buildStorePageIndex(
      [member("user-2", "Bob", ["b1", "12345", "21000000000000x", BOOK_A])],
      VIEWER,
      FAMILY,
      NOW,
    );

    expect(Object.keys(index.books)).toEqual([BOOK_A]);
  });

  it("lists every member sharing a book once, sorted", () => {
    const index = buildStorePageIndex(
      [
        member("user-3", "Carol", [BOOK_A]),
        member("user-2", "Alice", [BOOK_A, BOOK_A]),
        member("user-4", "Alice", [BOOK_A]),
      ],
      VIEWER,
      FAMILY,
      NOW,
    );

    expect(index.books[BOOK_A]).toEqual(["Alice", "Carol"]);
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "   "],
  ])(
    "falls back to the first 8 characters of the userId for %s name",
    (_n, name) => {
      const index = buildStorePageIndex(
        [member("abcdef0123456789", name, [BOOK_A])],
        VIEWER,
        FAMILY,
        NOW,
      );

      expect(index.books[BOOK_A]).toEqual(["abcdef01"]);
    },
  );

  it("trims a name and truncates it by code point, never splitting a surrogate pair", () => {
    const long = "😀".repeat(MAX_STORE_INDEX_NAME_LENGTH + 10);
    const index = buildStorePageIndex(
      [member("user-2", `  ${long}  `, [BOOK_A])],
      VIEWER,
      FAMILY,
      NOW,
    );

    const [name] = index.books[BOOK_A];
    expect(Array.from(name)).toHaveLength(MAX_STORE_INDEX_NAME_LENGTH);
    expect(name).toBe("😀".repeat(MAX_STORE_INDEX_NAME_LENGTH));
  });
});

describe("parseStorePageIndex", () => {
  it("accepts what buildStorePageIndex produced", () => {
    const built = buildStorePageIndex(
      [member("user-2", "Bob", [BOOK_A, BOOK_B])],
      VIEWER,
      FAMILY,
      NOW,
    );

    expect(parseStorePageIndex(JSON.parse(JSON.stringify(built)))).toEqual(
      built,
    );
  });

  it("accepts a null-prototype books object", () => {
    const books = Object.assign(Object.create(null) as object, {
      [BOOK_A]: ["Bob"],
    });

    expect(parseStorePageIndex(validIndex(books))?.books).toEqual({
      [BOOK_A]: ["Bob"],
    });
  });

  class NotPlain {
    [key: string]: unknown;
  }

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a string", "index"],
    ["an array", [validIndex({})]],
    ["a non-plain object", Object.assign(new NotPlain(), validIndex({}))],
    ["another version", { ...validIndex({}), version: 3 }],
    ["a string version", { ...validIndex({}), version: "2" }],
    [
      "a version-1 index (no familyId)",
      {
        version: 1,
        viewerUserId: VIEWER,
        updatedAt: NOW.toISOString(),
        books: { [BOOK_A]: ["Bob"] },
      },
    ],
    [
      "a version-1 index carrying a familyId",
      { ...validIndex({}), version: 1 },
    ],
    ["a missing viewerUserId", { ...validIndex({}), viewerUserId: undefined }],
    ["an empty viewerUserId", { ...validIndex({}), viewerUserId: "" }],
    ["a numeric viewerUserId", { ...validIndex({}), viewerUserId: 7 }],
    ["a missing familyId", { ...validIndex({}), familyId: undefined }],
    ["an empty familyId", { ...validIndex({}), familyId: "" }],
    ["a numeric familyId", { ...validIndex({}), familyId: 7 }],
    ["a non-string updatedAt", { ...validIndex({}), updatedAt: 0 }],
    ["missing books", { ...validIndex({}), books: undefined }],
    ["books as an array", validIndex([] as unknown as Record<string, unknown>)],
    ["books of another class", { ...validIndex({}), books: new NotPlain() }],
    ["a key that is not a real book id", validIndex({ b1: ["Bob"] })],
    ["a names value that is not an array", validIndex({ [BOOK_A]: "Bob" })],
    ["a non-string name", validIndex({ [BOOK_A]: ["Bob", 7] })],
    [
      "a __proto__ key from JSON",
      JSON.parse(
        `{"version":2,"viewerUserId":"${VIEWER}","familyId":"${FAMILY}","updatedAt":"x","books":{"__proto__":["Eve"]}}`,
      ),
    ],
  ])("rejects the whole index for %s", (_name, raw) => {
    expect(parseStorePageIndex(raw)).toBeNull();
  });

  it(`accepts exactly ${MAX_STORE_INDEX_BOOKS} books and rejects one more`, () => {
    const books: Record<string, string[]> = {};
    for (let i = 0; i < MAX_STORE_INDEX_BOOKS; i += 1) {
      books[String(210000000000000 + i)] = ["Bob"];
    }
    expect(parseStorePageIndex(validIndex(books))).not.toBeNull();

    books[String(210000000000000 + MAX_STORE_INDEX_BOOKS)] = ["Bob"];
    expect(parseStorePageIndex(validIndex(books))).toBeNull();
  });

  it("cleans the names and drops a book left with none", () => {
    const parsed = parseStorePageIndex(
      validIndex({
        [BOOK_A]: [" Bob ", "", "Bob", "x".repeat(80)],
        [BOOK_B]: ["   "],
      }),
    );

    expect(parsed?.books).toEqual({
      [BOOK_A]: ["Bob", "x".repeat(MAX_STORE_INDEX_NAME_LENGTH)],
    });
  });

  it("never inherits a key from Object.prototype", () => {
    const parsed = parseStorePageIndex(validIndex({}));

    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.books)).toEqual([]);
  });
});

describe("lookupStoreChipNames", () => {
  const index: StorePageIndex = {
    version: 2,
    viewerUserId: VIEWER,
    familyId: FAMILY,
    updatedAt: NOW.toISOString(),
    books: { [BOOK_A]: ["Alice", "Bob"] },
  };

  it("returns the names sharing the book", () => {
    expect(lookupStoreChipNames(index, BOOK_A)).toEqual(["Alice", "Bob"]);
  });

  it.each([BOOK_B, "constructor", "toString", "__proto__"])(
    "returns [] for %s, which nobody shares",
    (bookId) => {
      expect(lookupStoreChipNames(index, bookId)).toEqual([]);
    },
  );

  it("returns a copy the caller cannot use to change the index", () => {
    lookupStoreChipNames(index, BOOK_A).push("Eve");

    expect(index.books[BOOK_A]).toEqual(["Alice", "Bob"]);
  });
});

describe("formatStoreChipText", () => {
  it.each([
    [["小明"], "小明 已開放這本書"],
    [["小明", "小華"], "小明、小華 已開放這本書"],
    [["小明", "小華", "阿美"], "小明、小華、阿美 已開放這本書"],
  ])("formats %j", (names, text) => {
    expect(formatStoreChipText(names)).toBe(text);
  });
});

describe("isStoreIndexFresh", () => {
  function builtAt(updatedAt: string): StorePageIndex {
    return {
      version: 2,
      viewerUserId: VIEWER,
      familyId: FAMILY,
      updatedAt,
      books: {},
    };
  }

  it("counts 30 days as the limit", () => {
    expect(STORE_INDEX_MAX_AGE_DAYS).toBe(30);
    expect(STORE_INDEX_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("tolerates 5 minutes of clock skew into the future", () => {
    expect(STORE_INDEX_FUTURE_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  it.each<[string, string, boolean]>([
    ["built just now", NOW.toISOString(), true],
    [
      "exactly 30 days old",
      new Date(NOW.getTime() - STORE_INDEX_MAX_AGE_MS).toISOString(),
      true,
    ],
    [
      "30 days and 1 ms old",
      new Date(NOW.getTime() - STORE_INDEX_MAX_AGE_MS - 1).toISOString(),
      false,
    ],
    [
      "built a minute in the future (clock moved back)",
      new Date(NOW.getTime() + 60 * 1000).toISOString(),
      true,
    ],
    [
      "built exactly 5 minutes in the future",
      new Date(NOW.getTime() + STORE_INDEX_FUTURE_TOLERANCE_MS).toISOString(),
      true,
    ],
    [
      "built 5 minutes and 1 ms in the future",
      new Date(
        NOW.getTime() + STORE_INDEX_FUTURE_TOLERANCE_MS + 1,
      ).toISOString(),
      false,
    ],
    [
      "built days in the future (clock ran ahead)",
      new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      false,
    ],
    ["an unparsable date", "not-a-date", false],
    ["an empty date", "", false],
  ])("is %s → %s", (_name, updatedAt, fresh) => {
    expect(isStoreIndexFresh(builtAt(updatedAt), NOW.getTime())).toBe(fresh);
  });
});

describe("formatStoreStaleText", () => {
  it("names the age limit in days and how to refresh", () => {
    expect(formatStoreStaleText()).toBe(
      "家人開放資料超過 30 天沒更新，打開家庭書櫃就會更新",
    );
    expect(formatStoreStaleText()).toContain(
      `超過 ${STORE_INDEX_MAX_AGE_DAYS} 天`,
    );
  });
});

describe("storeBookIdFromPath", () => {
  it.each<[string, string | null]>([
    [`/book/${BOOK_A}`, BOOK_A],
    [`/book/${BOOK_A}/`, BOOK_A],
    [`/book/${BOOK_A}.html`, null],
    [`/book/${BOOK_A}//`, null],
    [`/book/${BOOK_A}/reviews`, null],
    ["/book/abcdefghijklmno", null],
    ["/book/12345", null],
    ["/book/", null],
    ["/book", null],
    [`/books/${BOOK_A}`, null],
    [`/zh/book/${BOOK_A}`, null],
    ["/", null],
  ])("reads %s as %s", (pathname, expected) => {
    expect(storeBookIdFromPath(pathname)).toBe(expected);
  });
});

describe("readmooStore config", () => {
  it("builds store book URLs the book-link filter accepts", () => {
    expect(READMOO_STORE_BOOK_URL_BASE).toBe("https://readmoo.com/book/");
    expect(isAllowedBookUrl(`${READMOO_STORE_BOOK_URL_BASE}${BOOK_A}`)).toBe(
      true,
    );
  });

  it("asks for the store book pages only", () => {
    expect(READMOO_STORE_MATCH_PATTERNS).toEqual([
      "https://readmoo.com/book/*",
    ]);
  });

  it("pins the store-page selectors the E2E fixture is built on", () => {
    expect(READMOO_STORE_SELECTORS).toEqual({
      bookTitle: "h1.book-detail-title",
      bookMetaBox: ".book-meta-box",
    });
  });
});
