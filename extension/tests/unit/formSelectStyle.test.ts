import { describe, it, expect } from "vitest";
import type { CSSProperties } from "react";
import { formSelectStyle } from "@/dialog/formSelectStyle";

/**
 * Keys shared verbatim across both breakpoints. `padding` and `fontSize` are
 * asserted separately because they are the responsive-vs-regression focus.
 */
const SHARED_KEYS = {
  paddingRight: "2.25rem",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  backgroundColor: "white",
  color: "#334155",
  cursor: "pointer",
  outline: "none",
} as const;

describe("formSelectStyle", () => {
  it.each<{ name: string; isMobile: boolean; padding: string }>([
    { name: "desktop", isMobile: false, padding: "8px 12px" },
    { name: "mobile", isMobile: true, padding: "5px 12px" },
  ])("returns $padding padding on $name", ({ isMobile, padding }) => {
    expect(formSelectStyle(isMobile).padding).toBe(padding);
  });

  it.each<{ name: string; isMobile: boolean }>([
    { name: "desktop", isMobile: false },
    { name: "mobile", isMobile: true },
  ])("keeps fontSize at 14 on $name (regression guard)", ({ isMobile }) => {
    // fontSize must NOT change across breakpoints — only vertical padding does.
    expect(formSelectStyle(isMobile).fontSize).toBe(14);
  });

  it.each<{ name: string; isMobile: boolean }>([
    { name: "desktop", isMobile: false },
    { name: "mobile", isMobile: true },
  ])("includes all shared non-padding keys on $name", ({ isMobile }) => {
    expect(formSelectStyle(isMobile)).toMatchObject(SHARED_KEYS);
  });

  it("returns the full expected style object on desktop", () => {
    const expected: CSSProperties = {
      padding: "8px 12px",
      paddingRight: "2.25rem",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      fontSize: 14,
      backgroundColor: "white",
      color: "#334155",
      cursor: "pointer",
      outline: "none",
    };
    expect(formSelectStyle(false)).toEqual(expected);
  });

  it("returns the full expected style object on mobile", () => {
    const expected: CSSProperties = {
      padding: "5px 12px",
      paddingRight: "2.25rem",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      fontSize: 14,
      backgroundColor: "white",
      color: "#334155",
      cursor: "pointer",
      outline: "none",
    };
    expect(formSelectStyle(true)).toEqual(expected);
  });

  it("is pure: repeated calls with the same arg are deeply equal", () => {
    expect(formSelectStyle(false)).toEqual(formSelectStyle(false));
    expect(formSelectStyle(true)).toEqual(formSelectStyle(true));
  });

  it("does not mutate a prior result when called with a different arg", () => {
    const desktop = formSelectStyle(false);
    const snapshot = { ...desktop };
    // Calling with the other branch must not retroactively alter the first object.
    formSelectStyle(true);
    expect(desktop).toEqual(snapshot);
    expect(desktop.padding).toBe("8px 12px");
  });

  it("returns a fresh object each call (no shared mutable singleton)", () => {
    const a = formSelectStyle(false);
    const b = formSelectStyle(false);
    expect(a).not.toBe(b);
  });
});
