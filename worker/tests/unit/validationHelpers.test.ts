import { describe, it, expect } from "vitest";
import { isValidSha256Hex, isValidKeyFingerprint, timingSafeEqualHex } from "../../src/utils/validation";

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

describe("isValidKeyFingerprint", () => {
  it("accepts valid 64-char lowercase hex", () => {
    expect(isValidKeyFingerprint("a".repeat(64))).toBe(true);
    expect(isValidKeyFingerprint("f".repeat(64))).toBe(true);
  });

  it("rejects invalid formats (delegates to isValidSha256Hex)", () => {
    expect(isValidKeyFingerprint("A".repeat(64))).toBe(false);
    expect(isValidKeyFingerprint("a".repeat(63))).toBe(false);
    expect(isValidKeyFingerprint("")).toBe(false);
    expect(isValidKeyFingerprint("not-hex")).toBe(false);
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualHex("a".repeat(64), "a".repeat(64))).toBe(true);
  });

  it("returns false for differing strings of equal length", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(63) + "b";
    expect(timingSafeEqualHex(a, b)).toBe(false);
  });

  it("returns false when first byte differs", () => {
    const a = "a".repeat(64);
    const b = "b" + "a".repeat(63);
    expect(timingSafeEqualHex(a, b)).toBe(false);
  });

  it("returns false for different-length inputs", () => {
    expect(timingSafeEqualHex("a".repeat(64), "a".repeat(63))).toBe(false);
    expect(timingSafeEqualHex("", "a")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
