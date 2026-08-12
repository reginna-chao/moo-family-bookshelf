import { describe, it, expect } from "vitest";
import {
  isJsonObject,
  sanitizeDisplayName,
  validateDisplayName,
} from "../../src/utils/validation";

describe("sanitizeDisplayName", () => {
  it("returns empty string for undefined/null", () => {
    expect(sanitizeDisplayName(undefined)).toBe("");
    expect(sanitizeDisplayName(null)).toBe("");
  });

  it("returns null for non-string", () => {
    expect(sanitizeDisplayName(123)).toBeNull();
    expect(sanitizeDisplayName(true)).toBeNull();
  });

  it("trims whitespace", () => {
    expect(sanitizeDisplayName("  小明  ")).toBe("小明");
  });

  it("returns null when exceeds 20 chars", () => {
    expect(sanitizeDisplayName("a".repeat(21))).toBeNull();
  });

  it("allows exactly 20 chars", () => {
    expect(sanitizeDisplayName("a".repeat(20))).toBe("a".repeat(20));
  });

  it("strips zero-width characters", () => {
    expect(sanitizeDisplayName("小\u200B明")).toBe("小明");
    expect(sanitizeDisplayName("\uFEFF小明")).toBe("小明");
  });

  it("strips control characters", () => {
    expect(sanitizeDisplayName("小\u0000明")).toBe("小明");
    expect(sanitizeDisplayName("小\u001F明")).toBe("小明");
    expect(sanitizeDisplayName("小\u007F明")).toBe("小明");
  });

  it("strips directional override characters", () => {
    expect(sanitizeDisplayName("小\u202A明\u202E")).toBe("小明");
    expect(sanitizeDisplayName("\u2066小明\u2069")).toBe("小明");
  });

  it("allows normal CJK and emoji", () => {
    expect(sanitizeDisplayName("小明🎉")).toBe("小明🎉");
  });
});

describe("validateDisplayName", () => {
  it("returns null for undefined/null", () => {
    expect(validateDisplayName(undefined)).toBeNull();
    expect(validateDisplayName(null)).toBeNull();
  });

  it("allows empty string", () => {
    expect(validateDisplayName("")).toBe("");
  });

  it("strips unsafe unicode and trims", () => {
    expect(validateDisplayName("  小\u200B明  ")).toBe("小明");
  });

  it("checks length after stripping", () => {
    // 20 visible chars + zero-width chars should pass
    const name = "a".repeat(20) + "\u200B".repeat(5);
    expect(validateDisplayName(name)).toBe("a".repeat(20));
  });
});

describe("isJsonObject", () => {
  it.each<{ label: string; value: unknown }>([
    { label: "an empty object", value: {} },
    { label: "a flat object", value: { a: 1 } },
    { label: "a nested object", value: { a: { b: { c: [1, 2] } } } },
    { label: "a displayName body", value: { displayName: "小明" } },
    { label: "an object holding a null value", value: { apiEndpoint: null } },
    { label: "an object parsed from JSON", value: JSON.parse('{"a":1}') },
  ])("accepts $label", ({ value }) => {
    expect(isJsonObject(value)).toBe(true);
  });

  it.each<{ label: string; value: unknown }>([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "an empty array", value: [] },
    { label: "a non-empty array", value: [1] },
    { label: "an array of objects", value: [{ a: 1 }] },
    { label: "an array parsed from JSON", value: JSON.parse("[1,2]") },
    { label: "a truthy number", value: 5 },
    { label: "zero", value: 0 },
    { label: "a truthy string", value: "x" },
    { label: "an empty string", value: "" },
    { label: "true", value: true },
    { label: "false", value: false },
  ])("rejects $label", ({ value }) => {
    expect(isJsonObject(value)).toBe(false);
  });

  // Why the helper exists: all three call sites (the family displayName and
  // apiEndpoint handlers, plus parseFamilyPrefs) evaluate `key in body`
  // immediately after this guard. A truthy primitive reaching `in` throws a
  // TypeError, which would surface as a 500 instead of a clean 400.
  it.each<{ label: string; value: unknown }>([
    { label: "a number", value: 5 },
    { label: "a string", value: "x" },
    { label: "a boolean", value: true },
  ])(
    "keeps a following `key in value` from throwing on $label",
    ({ value }) => {
      // Baseline: an unguarded `in` on a truthy primitive is exactly the failure
      // this guard prevents.
      expect(() => "displayName" in (value as object)).toThrow(TypeError);
      // The call-site pattern short-circuits before `in` is ever evaluated.
      expect(() => isJsonObject(value) && "displayName" in value).not.toThrow();
    },
  );

  it("narrows an accepted value to a keyed record", () => {
    const body: unknown = JSON.parse('{"displayName":"小明"}');
    expect(isJsonObject(body)).toBe(true);
    // Compile-time half of the contract: the `value is Record<string, unknown>`
    // predicate is what lets call sites read keys off a previously `unknown` body.
    if (!isJsonObject(body)) throw new Error("expected a JSON object");
    expect(body.displayName).toBe("小明");
  });
});
