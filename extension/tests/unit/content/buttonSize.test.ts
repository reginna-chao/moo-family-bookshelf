import { describe, it, expect } from "vitest";
import { getButtonSizeStyles, isFloatingIconSize } from "@/content/index";

describe("getButtonSizeStyles", () => {
  it.each([
    { size: "small" as const, padding: "6px 12px", fontSize: "12px" },
    { size: "medium" as const, padding: "12px 20px", fontSize: "14px" },
    { size: "large" as const, padding: "14px 24px", fontSize: "16px" },
  ])("returns correct styles for '$size'", ({ size, padding, fontSize }) => {
    expect(getButtonSizeStyles(size)).toEqual({ padding, fontSize });
  });
});

describe("isFloatingIconSize", () => {
  it.each([
    { value: "small", expected: true },
    { value: "medium", expected: true },
    { value: "large", expected: true },
    { value: "huge", expected: false },
    { value: "", expected: false },
    { value: null, expected: false },
    { value: undefined, expected: false },
    { value: 42, expected: false },
  ])("returns $expected for '$value'", ({ value, expected }) => {
    expect(isFloatingIconSize(value)).toBe(expected);
  });
});
