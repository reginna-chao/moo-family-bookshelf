import { describe, it, expect } from "vitest";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

/**
 * `safeErrorText` is the shared coercion both apps put between a backend error
 * envelope and React state. `readEnvelope` in either API client bare-casts
 * `response.json()`, and the endpoint is user-configurable (BYO backend via the
 * sync code's `@host`), so every field the types call `string` is really
 * `unknown` at runtime. A non-string that reaches a JSX child makes React 19
 * throw ("Objects are not valid as a React child") and neither app mounts an
 * ErrorBoundary — the Dialog / page goes white.
 *
 * The `||` / `??` idioms this helper replaced do NOT cover that: `{} || fb` is
 * `{}` and `[] || fb` is `[]`, so exactly the two values React refuses to
 * render were the two that used to pass through.
 */

/** Fallback copy is per call site; these are two real ones, used verbatim. */
const FALLBACK = "儲存失敗，請重試";
const OTHER_FALLBACK = "驗證碼產生失敗，請重試";

/**
 * The complete set of values `error.message` can hold. `JSON.parse` output can
 * only be an object, array, string, number, boolean or null; `undefined` covers
 * a backend that omits the field entirely. Every non-string member — plus the
 * empty string, since a blank error is not a report — must degrade.
 */
const DEGRADING_CASES: { name: string; message: unknown }[] = [
  { name: "an object", message: { zh: "壞掉了" } },
  { name: "a nested object", message: { error: { message: "壞掉了" } } },
  { name: "an array", message: ["壞掉了"] },
  { name: "a number", message: 123 },
  { name: "zero", message: 0 },
  { name: "a boolean", message: true },
  { name: "null", message: null },
  { name: "a missing field (undefined)", message: undefined },
  { name: "an empty string", message: "" },
];

describe("safeErrorText", () => {
  it.each(DEGRADING_CASES)(
    "returns the caller's fallback for $name",
    ({ message }) => {
      expect(safeErrorText(message, FALLBACK)).toBe(FALLBACK);
    },
  );

  it.each([
    { name: "a localized server message", message: "帳號不存在" },
    { name: "an English server message", message: "Too many requests" },
    // Only the EMPTY string degrades — a message made of spaces is still a
    // string React can render, and trimming is not this helper's job.
    { name: "a whitespace-only message", message: " " },
    { name: "a multi-line message", message: "第一行\n第二行" },
    { name: "a single character", message: "!" },
  ])("passes through $name unchanged", ({ message }) => {
    expect(safeErrorText(message, FALLBACK)).toBe(message);
  });

  it("never returns a non-string, whatever the backend sent", () => {
    // The property that makes the result safe as a JSX child. Asserted over the
    // whole table so a future branch cannot return the raw input for one case.
    for (const { message } of DEGRADING_CASES) {
      expect(typeof safeErrorText(message, FALLBACK)).toBe("string");
    }
  });

  it("carries no copy of its own — the fallback is whatever the call site passed", () => {
    // 25 call sites across Extension and PWA each supply their own action copy;
    // a fallback baked into the helper would silently reword all of them.
    expect(safeErrorText(null, OTHER_FALLBACK)).toBe(OTHER_FALLBACK);
    expect(safeErrorText({}, OTHER_FALLBACK)).toBe(OTHER_FALLBACK);
  });
});
