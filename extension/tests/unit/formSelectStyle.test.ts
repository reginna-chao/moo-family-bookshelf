import { describe, it, expect } from "vitest";
import type { CSSProperties } from "react";
import { formSelectStyle } from "@/dialog/formSelectStyle";

/**
 * Keys shared verbatim across both breakpoints. `height` and `fontSize` are
 * asserted separately: `height` is the responsive value, `fontSize` is the
 * regression guard. The design change pinned a fixed `height` (40 desktop / 32
 * mobile) with `boxSizing: "border-box"` and dropped vertical padding, so the
 * horizontal-only `padding: "0 12px"` is now shared across breakpoints too.
 */
const SHARED_KEYS = {
  boxSizing: "border-box",
  padding: "0 12px",
  paddingRight: "2.25rem",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  backgroundColor: "white",
  color: "#334155",
  cursor: "pointer",
  outline: "none",
} as const;

describe("formSelectStyle", () => {
  it.each<{ name: string; isMobile: boolean; height: number }>([
    { name: "desktop", isMobile: false, height: 40 },
    { name: "mobile", isMobile: true, height: 32 },
  ])("returns height $height on $name", ({ isMobile, height }) => {
    // Height is the responsive dimension now (40 desktop / 32 mobile), pinned to
    // match the toolbar icon buttons; vertical padding was removed.
    expect(formSelectStyle(isMobile).height).toBe(height);
  });

  it.each<{ name: string; isMobile: boolean }>([
    { name: "desktop", isMobile: false },
    { name: "mobile", isMobile: true },
  ])("keeps horizontal padding '0 12px' on $name", ({ isMobile }) => {
    // Padding is horizontal-only and identical across breakpoints; height now
    // carries the responsive behaviour.
    expect(formSelectStyle(isMobile).padding).toBe("0 12px");
  });

  it.each<{ name: string; isMobile: boolean }>([
    { name: "desktop", isMobile: false },
    { name: "mobile", isMobile: true },
  ])("keeps fontSize at 14 on $name (regression guard)", ({ isMobile }) => {
    // fontSize must NOT change across breakpoints — only height does.
    expect(formSelectStyle(isMobile).fontSize).toBe(14);
  });

  it.each<{ name: string; isMobile: boolean }>([
    { name: "desktop", isMobile: false },
    { name: "mobile", isMobile: true },
  ])("includes all shared non-height keys on $name", ({ isMobile }) => {
    expect(formSelectStyle(isMobile)).toMatchObject(SHARED_KEYS);
  });

  it("returns the full expected style object on desktop", () => {
    const expected: CSSProperties = {
      boxSizing: "border-box",
      height: 40,
      padding: "0 12px",
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
      boxSizing: "border-box",
      height: 32,
      padding: "0 12px",
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
    // height is the responsive value now, so it is the meaningful cross-call guard.
    expect(desktop.height).toBe(40);
  });

  it("returns a fresh object each call (no shared mutable singleton)", () => {
    const a = formSelectStyle(false);
    const b = formSelectStyle(false);
    expect(a).not.toBe(b);
  });
});
