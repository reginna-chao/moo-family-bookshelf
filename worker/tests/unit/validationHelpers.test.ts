import { describe, it, expect } from "vitest";
import { isValidSha256Hex } from "../../src/utils/validation";

describe("isValidSha256Hex", () => {
  it("accepts valid 64-char lowercase hex", () => {
    expect(isValidSha256Hex("a".repeat(64))).toBe(true);
    expect(isValidSha256Hex("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isValidSha256Hex("A".repeat(64))).toBe(false);
  });

  it("rejects 63-char string (too short)", () => {
    expect(isValidSha256Hex("a".repeat(63))).toBe(false);
  });

  it("rejects 65-char string (too long)", () => {
    expect(isValidSha256Hex("a".repeat(65))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSha256Hex("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidSha256Hex("g".repeat(64))).toBe(false);
    expect(isValidSha256Hex("z".repeat(64))).toBe(false);
    expect(isValidSha256Hex("!".repeat(64))).toBe(false);
  });

  it("rejects string with spaces", () => {
    expect(isValidSha256Hex("a".repeat(63) + " ")).toBe(false);
  });
});

