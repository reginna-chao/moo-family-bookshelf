import { describe, it, expect } from "vitest";
import {
  bodyLimitFor,
  DEFAULT_MAX_BODY_SIZE,
  maxBodySizeFor,
  payloadTooLargeMessage,
  PUT_BOOKS_MAX_BODY_SIZE,
} from "../../src/utils/bodyLimit";
import { USER1 } from "../helpers/ids";

const BOOKS_PATH = `/api/user/${USER1}/books`;

describe("body limit constants", () => {
  it("keeps the 256KB default and the 2MB books-PUT limit", () => {
    expect(DEFAULT_MAX_BODY_SIZE).toBe(262144);
    expect(PUT_BOOKS_MAX_BODY_SIZE).toBe(2097152);
  });
});

describe("bodyLimitFor", () => {
  it("gives PUT /api/user/:id/books the 2MB limit", () => {
    expect(bodyLimitFor("PUT", BOOKS_PATH)).toEqual({
      maxBytes: PUT_BOOKS_MAX_BODY_SIZE,
      label: "2MB",
    });
  });

  it.each([
    ["PATCH on the books path", "PATCH", BOOKS_PATH],
    ["GET on the books path", "GET", BOOKS_PATH],
    ["POST on the books path", "POST", BOOKS_PATH],
    ["DELETE on the books path", "DELETE", BOOKS_PATH],
    ["lowercase put", "put", BOOKS_PATH],
    ["an extra trailing segment", "PUT", `/api/user/${USER1}/books/extra`],
    ["two id segments", "PUT", "/api/user/a/b/books"],
    ["a trailing slash", "PUT", `/api/user/${USER1}/books/`],
    ["an empty id segment", "PUT", "/api/user//books"],
    ["the family-prefs route", "PUT", `/api/user/${USER1}/family-prefs`],
    ["a family books-like path", "PUT", "/api/family/x/books"],
    ["the family create route", "POST", "/api/family"],
    ["a non-/api prefix", "PUT", `/x/api/user/${USER1}/books`],
  ])("keeps the 256KB default for %s", (_label, method, path) => {
    expect(bodyLimitFor(method, path)).toEqual({
      maxBytes: DEFAULT_MAX_BODY_SIZE,
      label: "256KB",
    });
  });
});

describe("maxBodySizeFor", () => {
  it.each([
    ["PUT", BOOKS_PATH, PUT_BOOKS_MAX_BODY_SIZE],
    ["PATCH", BOOKS_PATH, DEFAULT_MAX_BODY_SIZE],
    ["PUT", `/api/user/${USER1}/family-prefs`, DEFAULT_MAX_BODY_SIZE],
    ["PUT", `/api/user/${USER1}/books/`, DEFAULT_MAX_BODY_SIZE],
  ])("%s %s → %d bytes", (method, path, expected) => {
    expect(maxBodySizeFor(method, path)).toBe(expected);
  });
});

describe("payloadTooLargeMessage", () => {
  it.each([
    ["PATCH", "Request body exceeds 256KB limit"],
    ["PUT", "Request body exceeds 2MB limit"],
  ])(
    "renders the exact 413 message for %s on the books path",
    (method, expected) => {
      expect(payloadTooLargeMessage(bodyLimitFor(method, BOOKS_PATH))).toBe(
        expected,
      );
    },
  );
});
