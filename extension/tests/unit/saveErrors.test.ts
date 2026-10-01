import { describe, it, expect } from "vitest";
import {
  BOOKS_TOO_LARGE_MESSAGE,
  booksSaveErrorText,
} from "moo-family-bookshelf-shared/personal/saveErrors";

/**
 * `booksSaveErrorText` is the shared display rule for a refused personal-books
 * upload (Extension save / sync / auto-setup, PWA save). The Worker answers an
 * oversized body with `413 { code: "PAYLOAD_TOO_LARGE", message: "Request body
 * exceeds …" }`; that English byte-limit message means nothing to a reader, so
 * the code alone selects local 繁中 copy. Every other error keeps going through
 * `safeErrorText` exactly as the call sites did before (that helper's full
 * value domain is pinned in tests/unit/safeErrorText.test.ts).
 *
 * The envelope is bare-cast from `response.json()`, so `code` and `message`
 * may hold any JSON value at runtime — the cases below pass such values through
 * an `unknown` cast on purpose.
 */

/** Real fallbacks used by the call sites, verbatim. */
const SAVE_FALLBACK = "儲存失敗，請稍後再試";
const SYNC_FALLBACK = "同步書單失敗，請稍後再試";

/** The Worker's own 413 message shape (worker/src/utils/bodyLimit.ts). */
const SERVER_413_MESSAGE = "Request body exceeds 2MB limit";

type LooseError = Parameters<typeof booksSaveErrorText>[0];
const asError = (code: unknown, message: unknown): LooseError =>
  ({ code, message }) as unknown as LooseError;

describe("booksSaveErrorText", () => {
  it("pins the production copy for an oversized upload", () => {
    // Exact equality so a reworded constant is a deliberate, visible change.
    expect(BOOKS_TOO_LARGE_MESSAGE).toBe(
      "書太多了，伺服器沒辦法一次存下整份書單。如果家庭用的是自架伺服器，請管理者把伺服器更新到最新版。",
    );
  });

  it.each([
    { name: "the server's English message", message: SERVER_413_MESSAGE },
    { name: "a localized message", message: "內容太大" },
    { name: "an object message", message: { zh: "壞掉了" } },
    { name: "a missing message", message: undefined },
    { name: "an empty message", message: "" },
  ])(
    "returns the too-large copy for PAYLOAD_TOO_LARGE carrying $name",
    ({ message }) => {
      for (const fallback of [SAVE_FALLBACK, SYNC_FALLBACK]) {
        expect(
          booksSaveErrorText(asError("PAYLOAD_TOO_LARGE", message), fallback),
        ).toBe(BOOKS_TOO_LARGE_MESSAGE);
      }
    },
  );

  it.each([
    { name: "a generic server error", code: "BOOM", message: "patch failed" },
    { name: "a rate-limit error", code: "RATE_LIMITED", message: "稍後再試" },
    {
      name: "a near-miss lowercase code",
      code: "payload_too_large",
      message: "Request body exceeds 2MB limit",
    },
  ])("passes through the server message for $name", ({ code, message }) => {
    expect(booksSaveErrorText(asError(code, message), SAVE_FALLBACK)).toBe(
      message,
    );
  });

  it.each([
    { name: "an object message", message: { zh: "壞掉了" } },
    { name: "an array message", message: ["壞掉了"] },
    { name: "a number message", message: 413 },
    { name: "a null message", message: null },
    { name: "a missing message", message: undefined },
    { name: "an empty message", message: "" },
  ])(
    "returns the caller's fallback for another code with $name",
    ({ message }) => {
      expect(booksSaveErrorText(asError("BOOM", message), SAVE_FALLBACK)).toBe(
        SAVE_FALLBACK,
      );
      expect(booksSaveErrorText(asError("BOOM", message), SYNC_FALLBACK)).toBe(
        SYNC_FALLBACK,
      );
    },
  );

  it.each([
    { name: "a number", code: 413 },
    { name: "null", code: null },
    { name: "undefined", code: undefined },
    { name: "an object", code: { code: "PAYLOAD_TOO_LARGE" } },
    { name: "an array", code: ["PAYLOAD_TOO_LARGE"] },
    { name: "a boolean", code: true },
  ])(
    "treats a non-string code ($name) as an ordinary error without throwing",
    ({ code }) => {
      expect(
        booksSaveErrorText(asError(code, "伺服器錯誤"), SAVE_FALLBACK),
      ).toBe("伺服器錯誤");
      expect(
        booksSaveErrorText(asError(code, { zh: "壞掉了" }), SAVE_FALLBACK),
      ).toBe(SAVE_FALLBACK);
    },
  );
});
