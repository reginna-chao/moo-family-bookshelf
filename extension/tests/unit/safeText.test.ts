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
 * `pwa/tests/unit/safeText.test.ts` for the same reason `publicShelfDiff` is:
 * each app bundles the source itself, and each CI job runs only its own suite.
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
 * The record half of the container tier. THREE branches, and the split between
 * the last two is the whole point:
 *
 *   - a plain object is sanitized field by field;
 *   - `null` / `undefined` pass through UNCHANGED, because a missing payload has
 *     to STAY missing. `checkVersion`'s `if (data === null) return null` and
 *     `sanitizeEnvelope`'s `if (res.data === undefined) return res` (both in
 *     `extension/src/api/client.ts`) are load-bearing on that, and fabricating
 *     an entity here would turn "the backend sent nothing" into "the backend
 *     sent an empty family" — a different and worse lie;
 *   - anything ELSE — a primitive, an array — walks straight past those very
 *     guards (`[]` and `"x"` are both truthy) and would then crash the first
 *     field read, so it degrades to a fully materialized EMPTY entity instead.
 *
 * PR #149's review is why the last branch exists: `data: []` and `data: "x"`
 * from `GET /api/family/:id/members` reach `setMembers(response.data.members)`
 * (`extension/src/dialog/FamilyDataContext.tsx:217`) as `undefined`, and
 * `members.length` (`extension/src/dialog/MemberList.tsx:82`) then throws from
 * RENDER — where no caller `try/catch` can reach it, and with no ErrorBoundary
 * in either app that is a permanent white screen.
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

  // The ONLY pass-through branch left. Absence stays absence: every caller
  // already guards it, so materializing here would invent a payload.
  it.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("passes $name through without calling the sanitizer", ({ value }) => {
    const sanitize = vi.fn((record: unknown) => record);

    expect(() => sanitizeRecord(value, sanitize)).not.toThrow();
    expect(sanitizeRecord(value, sanitize)).toBe(value);
    expect(sanitize).not.toHaveBeenCalled();
  });

  // FAIL-CLOSED: garbage that is neither a record nor absent slips past the
  // callers' truthiness guards, so it becomes a fully materialized empty
  // entity rather than a TypeError one render later.
  it.each([
    { name: "a string", value: "not an object" },
    { name: "the empty string", value: "" },
    { name: "a number", value: 42 },
    { name: "the number 0", value: 0 },
    { name: "a boolean", value: true },
    { name: "an array", value: ["a"] },
    { name: "an empty array", value: [] },
  ])("materializes an empty entity from $name", ({ value }) => {
    const sanitize = vi.fn(emptyTitle);
    const garbage = value as unknown as LooseRecord;

    expect(() => sanitizeRecord(garbage, sanitize)).not.toThrow();
    expect(sanitizeRecord(garbage, sanitize)).toEqual({ title: "" });
    // Handed `{}`, never the garbage itself.
    expect(sanitize).toHaveBeenCalledWith({});
  });

  // An array is garbage here and is never SPREAD: `{ ...arr, title: "" }` would
  // carry the array's numeric keys and dress a malformed payload up as a valid
  // entity. Excluding arrays is also what keeps the predicate identical to
  // `isRecord` in `shared/src/borrow/validation.ts`.
  it("does not spread an array's numeric keys into the result", () => {
    const result = sanitizeRecord(
      ["first", "second"] as unknown as LooseRecord,
      emptyTitle,
    );

    expect(Object.keys(result)).toEqual(["title"]);
    expect(Array.isArray(result)).toBe(false);
  });

  it("does not mutate the record it was given", () => {
    const original: LooseRecord = { title: { boom: true }, keep: 1 };
    const snapshot = JSON.stringify(original);

    const result = sanitizeRecord(original, emptyTitle);

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(result).not.toBe(original);
  });
});

/**
 * The list half of the container tier, FAIL-CLOSED with no pass-through escape
 * hatch at all — where `sanitizeRecord` still lets `null` / `undefined` reach
 * the caller's own guard, a MISSING list materializes as `[]` here, because a
 * list is consumed differently: it goes straight into React state and is read
 * back with `.map` / `.length` from render.
 *
 * PR #149's review filed the two reproductions this block pins:
 * `GET /api/family/:id/members` answering `members: [null]` used to be stored
 * verbatim by `setMembers` (`extension/src/dialog/FamilyDataContext.tsx:217`,
 * outside any `try`) and detonate on the NEXT render at `members.map` +
 * `member.displayName` (`extension/src/dialog/MemberList.tsx:295` / `:49`);
 * `members: "oops"` did the same at `members.length`
 * (`extension/src/dialog/MemberList.tsx:82`). A throw from render is unreachable
 * to every caller `try/catch`, and with no ErrorBoundary in either app it is a
 * permanent white screen.
 *
 * Losing a hostile element is affordable here in a way it is not for a record:
 * "no members" / "no books" is a state the UI already renders. The stricter
 * precedent is `shared/src/borrow/validation.ts` (PR #144), which this
 * layer is now aligned to.
 */
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
    { name: "undefined (the field was omitted)", value: undefined },
    { name: "an object", value: { members: 1 } },
    { name: "a number", value: 7 },
    { name: "a boolean", value: true },
  ])("degrades a container that is $name to an empty list", ({ value }) => {
    const sanitize = vi.fn(emptyTitle);
    const list = value as unknown as LooseRecord[];

    expect(() => sanitizeList(list, sanitize)).not.toThrow();
    expect(sanitizeList(list, sanitize)).toEqual([]);
    expect(sanitize).not.toHaveBeenCalled();
  });

  // An element that cannot carry fields is DROPPED, never passed through: a
  // single `null` row used to be enough to throw `member.displayName` out of
  // `.map` and take the whole family shelf down.
  it.each([
    { name: "null", value: null },
    { name: "a string", value: "plain" },
    { name: "a number", value: 42 },
    { name: "a boolean", value: true },
    { name: "a nested array", value: ["nested"] },
  ])("drops an element that is $name", ({ value }) => {
    const sanitize = vi.fn(emptyTitle);
    const list = [value, { title: { a: 1 } }] as unknown as LooseRecord[];

    const result = sanitizeList(list, sanitize);

    expect(result).toEqual([{ title: "" }]);
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it("keeps every survivor when a hostile element sits between valid ones", () => {
    const list = [
      { title: { a: 1 } },
      null,
      { title: 42 },
    ] as unknown as LooseRecord[];

    expect(sanitizeList(list, emptyTitle)).toEqual([
      { title: "" },
      { title: "" },
    ]);
  });

  it("does not mutate the array it was given", () => {
    const original: LooseRecord[] = [{ title: { a: 1 } }];
    const snapshot = JSON.stringify(original);

    const result = sanitizeList(original, emptyTitle);

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(result).not.toBe(original);
  });
});
