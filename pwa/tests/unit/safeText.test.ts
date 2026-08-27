import { describe, it, expect, vi } from "vitest";
import {
  safeText,
  safeNullableText,
  sanitizeRecord,
  sanitizeList,
} from "moo-family-bookshelf-shared/api/safeText";

/**
 * Threat model (documented in full at `shared/src/api/safeText.ts`):
 *
 * Both API clients read their envelope through a bare cast
 * (`(await response.json()) as ApiResponse<T>`), and the endpoint is
 * user-configurable — a sync code's `@host` segment repoints the whole app at a
 * self-hosted (BYO) backend. So every field the types call `string` is really
 * `unknown` at runtime, and a hostile or merely buggy backend has two ways to
 * kill the UI outright:
 *
 *   1. An object reaching a JSX child — React 19 throws "Objects are not valid
 *      as a React child" and unmounts the tree.
 *   2. A string method on a non-string — `title.toLowerCase()` in `useSearch`,
 *      `createdAt.localeCompare()` in the borrow buckets, `title.trim()` in the
 *      public-share dialog. TypeError out of render / useMemo.
 *
 * Neither app has an ErrorBoundary, so either one is a PERMANENT white screen
 * until the user reloads — on the very tab where they would switch the endpoint
 * back.
 *
 * The module lives in `shared/` so the Extension and the PWA cannot drift on
 * what "degraded" means, and this file is mirrored at
 * `extension/tests/unit/safeText.test.ts` for the same reason `publicShelfDiff`
 * is: each app bundles the source itself, and each CI job runs only its own
 * suite.
 */

/**
 * Hostile values a real JSON body can carry in a field declared `string`.
 * Everything here is producible by `JSON.parse`, plus `undefined` for the
 * likeliest case of all — the backend simply omitted the field.
 */
const DEGRADING_VALUES: readonly { name: string; value: unknown }[] = [
  { name: "a plain object", value: { message: "boom" } },
  { name: "a nested object", value: { i18n: { "zh-TW": "標題" } } },
  { name: "an error-shaped object", value: { code: 500, detail: {} } },
  { name: "an array of strings", value: ["first", "second"] },
  { name: "an empty array", value: [] },
  { name: "a number", value: 42 },
  { name: "the number 0", value: 0 },
  { name: "a float", value: 3.14 },
  { name: "true", value: true },
  { name: "false", value: false },
  { name: "null", value: null },
  { name: "undefined (the field was omitted)", value: undefined },
];

/** Real strings, which must survive byte-identical. */
const PASS_THROUGH_VALUES: readonly { name: string; value: string }[] = [
  { name: "an ASCII string", value: "Readmoo" },
  { name: "a CJK string", value: "小明 的公開書櫃" },
  { name: "the EMPTY string (it IS the degraded form)", value: "" },
  { name: "a whitespace-only string", value: "   " },
  { name: "a multi-line string", value: "第一行\n第二行" },
  { name: "a single character", value: "書" },
  { name: "a numeric-looking string", value: "42" },
  { name: 'the literal "null"', value: "null" },
  { name: "an emoji string", value: "📚✨" },
  { name: "a very long string", value: "a".repeat(5000) },
];

/** Zero-width space: survives `trim()`, but a normalizing layer would eat it. */
const ZWSP = "\u200b";

describe("safeText", () => {
  it.each(DEGRADING_VALUES)('degrades $name to ""', ({ value }) => {
    expect(safeText(value)).toBe("");
  });

  it.each(PASS_THROUGH_VALUES)("returns $name byte-identical", ({ value }) => {
    expect(safeText(value)).toBe(value);
  });

  /**
   * There is no fallback parameter on purpose: fallback copy belongs at the
   * call sites that already carry it (`displayName || userId.slice(0, 8)`), and
   * `""` is falsy so those `||` chains keep supplying it. A helper that
   * substituted copy for `""` would break that contract.
   */
  it("passes the empty string through instead of substituting a fallback", () => {
    expect(safeText("")).toBe("");
  });

  // This layer coerces TYPES. Trimming or normalizing content here would make
  // the client silently rewrite what the server stored.
  it.each(["  台北  ", "\ttabbed\t", "trailing newline\n", `zero${ZWSP}width`])(
    "neither trims nor normalizes %j",
    (value) => {
      expect(safeText(value)).toBe(value);
    },
  );

  // The whole point of the layer: no caller can ever hold a non-string in a
  // field the types promise is a string.
  it("never returns a non-string, for any input in the matrix", () => {
    for (const { value } of [...DEGRADING_VALUES, ...PASS_THROUGH_VALUES]) {
      expect(typeof safeText(value)).toBe("string");
    }
  });

  it("never throws, for any input in the matrix", () => {
    for (const { value } of [...DEGRADING_VALUES, ...PASS_THROUGH_VALUES]) {
      expect(() => safeText(value)).not.toThrow();
    }
  });
});

describe("safeNullableText", () => {
  it.each(PASS_THROUGH_VALUES)("returns $name byte-identical", ({ value }) => {
    expect(safeNullableText(value)).toBe(value);
  });

  it.each(DEGRADING_VALUES)("degrades $name to null", ({ value }) => {
    expect(safeNullableText(value)).toBeNull();
  });

  /**
   * `apiEndpoint: null` means "this family uses the default endpoint", not
   * "missing" — the tri-state has to survive intact or a family record starts
   * claiming a custom endpoint it never had.
   */
  it("keeps an explicit null as null", () => {
    expect(safeNullableText(null)).toBeNull();
  });

  it("degrades undefined to null, leaving absence for the caller to guard", () => {
    expect(safeNullableText(undefined)).toBeNull();
  });

  it("never returns anything but a string or null", () => {
    for (const { value } of [...DEGRADING_VALUES, ...PASS_THROUGH_VALUES]) {
      const result = safeNullableText(value);
      expect(result === null || typeof result === "string").toBe(true);
    }
  });
});

/** A record shape loose enough to hold every hostile value under test. */
interface LooseRecord {
  title: unknown;
  keep?: number;
}

const emptyTitle = (record: LooseRecord): LooseRecord => ({
  ...record,
  title: "",
});

/**
 * The fail-safe half of the layer. Reading fields off a payload that is not a
 * non-null object would throw a TypeError straight out of the API client —
 * turning the hardening into the very failure it exists to prevent. Such a
 * payload must reach the caller exactly as it did before this layer existed.
 */
describe("sanitizeRecord", () => {
  it("applies the sanitizer to a non-null object", () => {
    const sanitize = vi.fn(emptyTitle);

    const result = sanitizeRecord<LooseRecord>(
      { title: { boom: true } },
      sanitize,
    );

    expect(result).toEqual({ title: "" });
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "a string", value: "not an object" },
    { name: "the empty string", value: "" },
    { name: "a number", value: 42 },
    { name: "the number 0", value: 0 },
    { name: "a boolean", value: true },
  ])("passes $name through without calling the sanitizer", ({ value }) => {
    const sanitize = vi.fn((record: unknown) => record);

    expect(() => sanitizeRecord(value, sanitize)).not.toThrow();
    expect(sanitizeRecord(value, sanitize)).toBe(value);
    expect(sanitize).not.toHaveBeenCalled();
  });

  // An array IS a non-null object, so it reaches the sanitizer. That is what
  // lets `sanitizeList` lean on `sanitizeRecord` for its own element guard.
  it("treats an array as a record and hands it to the sanitizer", () => {
    const sanitize = vi.fn((record: unknown[]) => record);

    sanitizeRecord(["a"], sanitize);

    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the record it was given", () => {
    const original: LooseRecord = { title: { boom: true }, keep: 1 };
    const snapshot = JSON.stringify(original);

    const result = sanitizeRecord(original, emptyTitle);

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(result).not.toBe(original);
  });
});

describe("sanitizeList", () => {
  it("sanitizes every element of a real array", () => {
    const list: LooseRecord[] = [
      { title: { a: 1 } },
      { title: 42 },
      { title: "ok" },
    ];

    expect(sanitizeList(list, emptyTitle)).toEqual([
      { title: "" },
      { title: "" },
      { title: "" },
    ]);
  });

  it("returns an empty array for an empty array", () => {
    expect(sanitizeList<LooseRecord>([], emptyTitle)).toEqual([]);
  });

  it.each([
    { name: "a string", value: "not a list" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "an object", value: { members: 1 } },
    { name: "a number", value: 7 },
  ])("passes $name through untouched instead of calling .map", ({ value }) => {
    const sanitize = vi.fn(emptyTitle);
    const list = value as unknown as LooseRecord[];

    expect(() => sanitizeList(list, sanitize)).not.toThrow();
    expect(sanitizeList(list, sanitize)).toBe(value);
    expect(sanitize).not.toHaveBeenCalled();
  });

  // A `null` entry inside an otherwise valid list is the shape that used to
  // throw: `null.title` is a TypeError, and one bad row would take the whole
  // family shelf down.
  it("lets null elements survive without handing them to the sanitizer", () => {
    const sanitize = vi.fn(emptyTitle);
    const list = [null, { title: { a: 1 } }, null] as unknown as LooseRecord[];

    const result = sanitizeList(list, sanitize);

    expect(result[0]).toBeNull();
    expect(result[1]).toEqual({ title: "" });
    expect(result[2]).toBeNull();
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it("lets primitive elements survive untouched", () => {
    const list = ["plain", 42, true] as unknown as LooseRecord[];

    expect(sanitizeList(list, emptyTitle)).toEqual(["plain", 42, true]);
  });

  it("does not mutate the array it was given", () => {
    const original: LooseRecord[] = [{ title: { a: 1 } }];
    const snapshot = JSON.stringify(original);

    const result = sanitizeList(original, emptyTitle);

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(result).not.toBe(original);
  });
});
