import { describe, it, expect } from "vitest";
import { computeAnchoredPosition } from "@/hooks/useAnchoredPosition";

/**
 * Build a DOMRect-like object. `computeAnchoredPosition` only reads
 * `top`, `bottom`, `right`, and `width`, so the rest are zero-filled.
 */
function rect(partial: {
  top: number;
  bottom: number;
  right: number;
  width: number;
}): DOMRect {
  const { top, bottom, right, width } = partial;
  return {
    top,
    bottom,
    right,
    width,
    left: right - width,
    height: bottom - top,
    x: right - width,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const GAP = 4;
const MARGIN = 8;

interface Case {
  name: string;
  triggerRect: DOMRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  expected: { top: number; left: number };
}

const cases: Case[] = [
  {
    // a) plenty of room below → open below, right-aligned to trigger.
    name: "opens below and right-aligns when there is room below",
    triggerRect: rect({ top: 100, bottom: 120, right: 500, width: 30 }),
    menuWidth: 120,
    menuHeight: 100,
    viewportWidth: 1000,
    viewportHeight: 800,
    // rawTop = 120 + 4 = 124; rawLeft = 500 - 120 = 380
    expected: { top: 124, left: 380 },
  },
  {
    // b) not enough room below, more room above → flip up above the trigger.
    name: "flips up when room below is insufficient and room above is larger",
    triggerRect: rect({ top: 700, bottom: 740, right: 500, width: 30 }),
    menuWidth: 120,
    menuHeight: 100,
    viewportWidth: 1000,
    viewportHeight: 800,
    // spaceBelow = 60 < 104 && top 700 > 60 → flipUp
    // rawTop = 700 - 100 - 4 = 596; rawLeft = 380
    expected: { top: 596, left: 380 },
  },
  {
    // c) right-aligned left would overflow the right edge → clamp to maxLeft.
    name: "clamps left to viewportWidth - menuWidth - margin when overflowing right",
    triggerRect: rect({ top: 100, bottom: 120, right: 995, width: 30 }),
    menuWidth: 120,
    menuHeight: 100,
    viewportWidth: 1000,
    viewportHeight: 800,
    // rawLeft = 995 - 120 = 875; maxLeft = 1000 - 120 - 8 = 872 → clamp 872
    // rawTop = 120 + 4 = 124
    expected: { top: 124, left: 872 },
  },
  {
    // d) right-aligned left would be negative → clamp to margin.
    name: "clamps left to margin when it would be negative",
    triggerRect: rect({ top: 100, bottom: 120, right: 50, width: 30 }),
    menuWidth: 120,
    menuHeight: 100,
    viewportWidth: 1000,
    viewportHeight: 800,
    // rawLeft = 50 - 120 = -70 → clamp to margin 8
    expected: { top: 124, left: MARGIN },
  },
  {
    // e) below position would overflow the bottom edge → clamp to maxTop.
    // Tiny menuHeight keeps spaceBelow >= menuHeight + gap so it does NOT flip.
    name: "clamps top to maxTop when below position overflows the bottom edge",
    triggerRect: rect({ top: 770, bottom: 790, right: 500, width: 30 }),
    menuWidth: 120,
    menuHeight: 2,
    viewportWidth: 1000,
    viewportHeight: 800,
    // spaceBelow = 10 >= 6 → no flip; rawTop = 790 + 4 = 794
    // maxTop = 800 - 2 - 8 = 790 → clamp 790
    expected: { top: 790, left: 380 },
  },
  {
    // f) panel larger than the viewport → maxLeft/maxTop go negative, so the
    // clamp upper bound is pinned to margin. Result must equal margin (never < 0).
    name: "pins to margin (not negative) when the panel is larger than the viewport",
    triggerRect: rect({ top: 50, bottom: 70, right: 200, width: 30 }),
    menuWidth: 400,
    menuHeight: 400,
    viewportWidth: 300,
    viewportHeight: 300,
    // maxLeft = 300 - 400 - 8 = -108 → Math.max(8, -108) = 8
    // maxTop = 300 - 400 - 8 = -108 → Math.max(8, -108) = 8
    // rawLeft = -200 → clamp(-200, 8, 8) = 8; rawTop = 74 → clamp(74, 8, 8) = 8
    expected: { top: MARGIN, left: MARGIN },
  },
];

describe("computeAnchoredPosition", () => {
  it.each(cases)(
    "$name",
    ({
      triggerRect,
      menuWidth,
      menuHeight,
      viewportWidth,
      viewportHeight,
      expected,
    }) => {
      const result = computeAnchoredPosition({
        triggerRect,
        menuWidth,
        menuHeight,
        viewportWidth,
        viewportHeight,
        gap: GAP,
        margin: MARGIN,
      });

      expect(result).toEqual(expected);
    },
  );

  it("never returns a position with negative coordinates", () => {
    for (const c of cases) {
      const result = computeAnchoredPosition({
        triggerRect: c.triggerRect,
        menuWidth: c.menuWidth,
        menuHeight: c.menuHeight,
        viewportWidth: c.viewportWidth,
        viewportHeight: c.viewportHeight,
        gap: GAP,
        margin: MARGIN,
      });
      expect(result.top).toBeGreaterThanOrEqual(0);
      expect(result.left).toBeGreaterThanOrEqual(0);
    }
  });
});
