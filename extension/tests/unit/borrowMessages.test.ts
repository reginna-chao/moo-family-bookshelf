import { describe, it, expect } from "vitest";
import {
  buildBorrowFailureText,
  BORROW_FAILURE_FALLBACK_TEXT,
} from "moo-family-bookshelf-shared/borrow/messages";

/**
 * Copy table for a FAILED borrow create, shared by the Extension dialog and the
 * PWA page. `shared/` has no test script of its own — its behaviour is covered
 * from `extension/tests/` and `pwa/tests/` (see `.claude/rules/frontend.md`),
 * and this file is that single cover: the PWA side deliberately does NOT
 * duplicate the table.
 *
 * This is also the ONE production-anchored pin for these sentences
 * (`.claude/rules/test.md` → Anti-Drift). Every other test — the two
 * `useBorrowAction` suites and the two family-shelf component suites — asserts
 * against `buildBorrowFailureText(code)` rather than a literal, so a wording
 * change fails exactly here and nowhere else.
 */

/** code → the exact 繁體中文 sentence production ships today. */
const COPY_BY_CODE: [string, string][] = [
  ["DUPLICATE_REQUEST", "這本書已有待處理的借閱申請，請到「借閱」查看"],
  ["RATE_LIMITED", "申請借閱過於頻繁，請稍後再試"],
  ["LENDING_DISABLED", "借閱功能已關閉，請在家庭設定確認你與對方的借閱權限"],
  ["NOT_FAMILY_MEMBER", "你已不在這個家庭，無法申請借閱"],
  ["INVALID_OWNER", "無法申請借閱這本書，書籍擁有者已不在這個家庭"],
  ["FAMILY_NOT_FOUND", "找不到這個家庭，請重新開啟書櫃後再試"],
  ["UNAUTHORIZED", "登入狀態已失效，請重新開啟書櫃後再試"],
  ["INVALID_COVER_URL", "書籍封面網址無效，無法建立借閱申請"],
  ["NETWORK_ERROR", "連線失敗，請檢查網路後再試"],
];

describe("buildBorrowFailureText", () => {
  it.each(COPY_BY_CODE)("maps %s to its own sentence", (code, expected) => {
    expect(buildBorrowFailureText(code)).toBe(expected);
  });

  it("gives every mapped code a distinct, non-empty sentence", () => {
    const texts = COPY_BY_CODE.map(([code]) => buildBorrowFailureText(code));

    expect(texts).toHaveLength(9);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("never reuses the generic fallback for a mapped code", () => {
    for (const [code] of COPY_BY_CODE) {
      expect(buildBorrowFailureText(code)).not.toBe(
        BORROW_FAILURE_FALLBACK_TEXT,
      );
    }
  });

  it("falls back for an unrecognized code", () => {
    // A BYO backend can answer with anything; an unknown code still owes the
    // user a report rather than a blank banner.
    expect(buildBorrowFailureText("SOMETHING_NEW")).toBe(
      BORROW_FAILURE_FALLBACK_TEXT,
    );
  });

  it("falls back when the rejection carried no code at all", () => {
    expect(buildBorrowFailureText(undefined)).toBe(
      BORROW_FAILURE_FALLBACK_TEXT,
    );
  });

  it("pins the fallback sentence itself", () => {
    expect(BORROW_FAILURE_FALLBACK_TEXT).toBe("申請借閱失敗，請稍後再試");
  });

  // The lookup is a Map precisely so a backend-controlled `code` cannot reach
  // Object.prototype: an object-literal table would answer "__proto__" with an
  // object and "toString" with a function, both of which would render as
  // garbage (or crash) in the banner.
  it.each([
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "valueOf",
    "hasOwnProperty",
  ])("returns the fallback string for the prototype key %s", (key) => {
    const text = buildBorrowFailureText(key);

    expect(typeof text).toBe("string");
    expect(text).toBe(BORROW_FAILURE_FALLBACK_TEXT);
  });
});
