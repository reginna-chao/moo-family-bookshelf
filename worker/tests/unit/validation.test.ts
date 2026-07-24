import { describe, it, expect } from "vitest";
import {
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
