import { describe, it, expect } from "vitest";
import {
  isValidShareToken,
  sanitizePublicShelfTitle,
  isValidExpiresDays,
} from "../../src/utils/validation";
import { isPublicRoute } from "../../src/utils/routes";

describe("isValidShareToken", () => {
  it.each([
    ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", true],
    ["0".repeat(32), true],
    ["abcdef0123456789abcdef0123456789", true],
  ])("accepts valid token %s", (input, expected) => {
    expect(isValidShareToken(input)).toBe(expected);
  });

  it.each([
    ["A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4", "uppercase"],
    ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d", "31 chars (too short)"],
    ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e", "33 chars (too long)"],
    ["a1b2c3d4-e5f6-a1b2-c3d4-e5f6a1b2c3d4", "contains hyphens"],
    ["g1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", "non-hex char g"],
    ["", "empty string"],
  ])("rejects %s (%s)", (input) => {
    expect(isValidShareToken(input)).toBe(false);
  });

  it.each([
    [123, "number"],
    [null, "null"],
    [undefined, "undefined"],
    [true, "boolean"],
  ])("rejects non-string: %s (%s)", (input, _desc) => {
    expect(isValidShareToken(input)).toBe(false);
  });
});

describe("sanitizePublicShelfTitle", () => {
  it("accepts valid title and trims whitespace", () => {
    expect(sanitizePublicShelfTitle("  我的書櫃  ")).toBe("我的書櫃");
  });

  it("accepts exactly 60 characters", () => {
    const title = "a".repeat(60);
    expect(sanitizePublicShelfTitle(title)).toBe(title);
  });

  it("returns null for empty string", () => {
    expect(sanitizePublicShelfTitle("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(sanitizePublicShelfTitle("   ")).toBeNull();
  });

  it("returns null when exceeding 60 characters", () => {
    expect(sanitizePublicShelfTitle("a".repeat(61))).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(sanitizePublicShelfTitle(123)).toBeNull();
    expect(sanitizePublicShelfTitle(null)).toBeNull();
    expect(sanitizePublicShelfTitle(undefined)).toBeNull();
  });

  it("strips zero-width characters", () => {
    expect(sanitizePublicShelfTitle("hello​world")).toBe("helloworld");
  });

  it("strips BOM characters", () => {
    expect(sanitizePublicShelfTitle("﻿title")).toBe("title");
  });

  it("returns null if only zero-width chars remain after stripping", () => {
    expect(sanitizePublicShelfTitle("​‏")).toBeNull();
  });
});

describe("isValidExpiresDays", () => {
  it.each([7, 30, 60, 90])("accepts valid value %d", (value) => {
    expect(isValidExpiresDays(value)).toBe(true);
  });

  it("accepts null (permanent)", () => {
    expect(isValidExpiresDays(null)).toBe(true);
  });

  it.each([
    [0, "zero"],
    [1, "one"],
    [15, "fifteen"],
    [100, "hundred"],
    [-1, "negative"],
  ])("rejects invalid number %d (%s)", (value) => {
    expect(isValidExpiresDays(value)).toBe(false);
  });

  it.each([
    ["30", "string"],
    [undefined, "undefined"],
    [true, "boolean"],
  ])("rejects non-number: %s (%s)", (value, _desc) => {
    expect(isValidExpiresDays(value)).toBe(false);
  });
});

describe("isPublicRoute — public bookshelf", () => {
  it("recognizes GET /api/public/:token as public", () => {
    expect(isPublicRoute("GET", "/api/public/abc123def456abc123def456abc123de")).toBe(true);
  });

  it("rejects POST /api/public/:token", () => {
    expect(isPublicRoute("POST", "/api/public/abc123")).toBe(false);
  });

  it("rejects GET /api/public/ without token", () => {
    expect(isPublicRoute("GET", "/api/public/")).toBe(false);
  });

  it("rejects GET /api/public (no trailing slash, no token)", () => {
    expect(isPublicRoute("GET", "/api/public")).toBe(false);
  });
});
