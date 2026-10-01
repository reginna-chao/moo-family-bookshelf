import { describe, it, expect } from "vitest";
import {
  SAVED_BOOKS_READ_FAILED_MESSAGE,
  loadSavedBooks,
  loadSavedBooksForSync,
} from "@/sync/savedBooks";
import { BoolFlag, type BookEntry } from "@/api/client";

const BOOK: BookEntry = {
  bookId: "210000000000001",
  title: "書",
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared: BoolFlag.TRUE,
};

describe("loadSavedBooks", () => {
  it("returns the books array and keeps the whole payload as raw", () => {
    const data = { books: [BOOK], displayName: "小明", extra: 1 };

    expect(loadSavedBooks(data)).toEqual({ books: [BOOK], raw: data });
  });

  const noRecordCases: Array<{ name: string; data: unknown }> = [
    { name: "null", data: null },
    { name: "undefined", data: undefined },
    { name: "a string", data: "books" },
    { name: "an object without books", data: { displayName: "x" } },
    { name: "an object whose books is not an array", data: { books: {} } },
  ];

  for (const { name, data } of noRecordCases) {
    it(`treats ${name} as no record`, () => {
      expect(loadSavedBooks(data)).toEqual({ books: [], raw: null });
    });
  }
});

describe("loadSavedBooksForSync", () => {
  it("loads an absent record (no error) as an empty first-sync list", () => {
    expect(loadSavedBooksForSync({ data: undefined })).toEqual({
      books: [],
      raw: null,
    });
  });

  it("loads a present record", () => {
    expect(loadSavedBooksForSync({ data: { books: [BOOK] } }).books).toEqual([
      BOOK,
    ]);
  });

  it("throws the server's message when the read failed", () => {
    expect(() =>
      loadSavedBooksForSync({
        error: { code: "INTERNAL_ERROR", message: "伺服器忙碌" },
      }),
    ).toThrow(new Error("伺服器忙碌"));
  });

  it.each([
    { name: "an object message", message: { zh: "x" } },
    { name: "an empty message", message: "" },
  ])(
    "throws the local read-failure copy when the error carries $name",
    ({ message }) => {
      expect(() =>
        loadSavedBooksForSync({
          error: { code: "INTERNAL_ERROR", message: message as string },
        }),
      ).toThrow(new Error(SAVED_BOOKS_READ_FAILED_MESSAGE));
    },
  );

  it("throws even when an error arrives alongside data", () => {
    expect(() =>
      loadSavedBooksForSync({
        data: { books: [BOOK] },
        error: { code: "RATE_LIMITED", message: "太多次了" },
      }),
    ).toThrow("太多次了");
  });

  it("pins the user-visible fallback copy", () => {
    expect(SAVED_BOOKS_READ_FAILED_MESSAGE).toBe("讀取書單失敗，請稍後再試");
  });
});
