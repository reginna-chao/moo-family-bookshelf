import { describe, it, expect } from "vitest";
import {
  encodePersonalBooksCache,
  readOwnedCachedBooks,
} from "@/dialog/personalBooksCache";
import { BoolFlag, type BookEntry } from "@/api/client";

/**
 * #272 (P0 privacy): the personal-books cache belongs to exactly one account.
 * It is stored as `{ userId, books }`, and the reader hands the books back
 * ONLY to that owner — anything else (another account's cache, the legacy
 * bare-array format, unreadable data) reads as `null`, so it is never uploaded
 * as someone else's shelf.
 */

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const BOOKS: BookEntry[] = [
  {
    bookId: "210000000000001",
    title: "快取書",
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  },
];

describe("encodePersonalBooksCache", () => {
  it("stores the books together with their owner's userId", () => {
    expect(JSON.parse(encodePersonalBooksCache(OWNER, BOOKS))).toEqual({
      userId: OWNER,
      books: BOOKS,
    });
  });

  it.each([
    { name: "with books", books: BOOKS },
    { name: "an empty list", books: [] as BookEntry[] },
  ])(
    "round-trips through readOwnedCachedBooks for the owner ($name)",
    ({ books }) => {
      expect(
        readOwnedCachedBooks(encodePersonalBooksCache(OWNER, books), OWNER),
      ).toEqual(books);
    },
  );

  it("does not round-trip for any other account", () => {
    expect(
      readOwnedCachedBooks(encodePersonalBooksCache(OWNER, BOOKS), OTHER),
    ).toBeNull();
  });
});

describe("readOwnedCachedBooks", () => {
  it.each([
    {
      name: "a cache owned by a different account",
      raw: JSON.stringify({ userId: OTHER, books: BOOKS }),
    },
    { name: "the legacy bare-array format", raw: JSON.stringify(BOOKS) },
    { name: "an empty legacy array", raw: "[]" },
    { name: "malformed JSON", raw: "{not json" },
    { name: "JSON null", raw: "null" },
    { name: "a JSON string", raw: JSON.stringify(OWNER) },
    { name: "a JSON number", raw: "42" },
    { name: "a missing userId", raw: JSON.stringify({ books: BOOKS }) },
    {
      name: "a non-string userId",
      raw: JSON.stringify({ userId: 42, books: BOOKS }),
    },
    {
      name: "an empty-string userId",
      raw: JSON.stringify({ userId: "", books: BOOKS }),
    },
    {
      name: "a userId differing only by case",
      raw: JSON.stringify({ userId: OWNER.toUpperCase(), books: BOOKS }),
    },
    {
      name: "missing books",
      raw: JSON.stringify({ userId: OWNER }),
    },
    {
      name: "non-array books",
      raw: JSON.stringify({ userId: OWNER, books: { 0: BOOKS[0] } }),
    },
    {
      name: "null books",
      raw: JSON.stringify({ userId: OWNER, books: null }),
    },
  ])("returns null for $name", ({ raw }) => {
    expect(readOwnedCachedBooks(raw, OWNER)).toBeNull();
  });

  it("returns the books when the cache is owned by the given account", () => {
    expect(
      readOwnedCachedBooks(
        JSON.stringify({ userId: OWNER, books: BOOKS }),
        OWNER,
      ),
    ).toEqual(BOOKS);
  });

  it("does not treat an empty userId argument as matching an unowned cache", () => {
    expect(
      readOwnedCachedBooks(JSON.stringify({ books: BOOKS }), ""),
    ).toBeNull();
    expect(readOwnedCachedBooks(JSON.stringify(BOOKS), "")).toBeNull();
  });
});
