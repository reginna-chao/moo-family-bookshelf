import { vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

/**
 * Geometry mirror of `pwa/src/components/PatternLock.tsx` (GRID_SIZE 3,
 * cellSize 80, padding 20). The component keeps these private, so the helper
 * duplicates them; a layout change there makes the hit tests here miss and the
 * tests fail loudly rather than drift silently.
 */
const GRID_SIZE = 3;
const CELL_SIZE = 80;
const PADDING = 20;
export const PATTERN_SVG_SIZE = CELL_SIZE * GRID_SIZE + PADDING * 2;

/** Centre of dot `index` in SVG user units (grid layout 0-1-2 / 3-4-5 / 6-7-8). */
export function patternDotCenter(index: number): { x: number; y: number } {
  return {
    x: PADDING + (index % GRID_SIZE) * CELL_SIZE + CELL_SIZE / 2,
    y: PADDING + Math.floor(index / GRID_SIZE) * CELL_SIZE + CELL_SIZE / 2,
  };
}

/**
 * jsdom reports a zero-sized box for every element, which makes the component's
 * client→SVG coordinate mapping divide by zero. Stub a square box the same size
 * as the viewBox so pointer coordinates map 1:1 onto SVG user units.
 *
 * @returns restore callback — call it in `afterEach` to avoid leaking the spy.
 */
export function stubPatternGridRect(): () => void {
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: PATTERN_SVG_SIZE,
    bottom: PATTERN_SVG_SIZE,
    width: PATTERN_SVG_SIZE,
    height: PATTERN_SVG_SIZE,
    toJSON: () => ({}),
  } as DOMRect;
  const spy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue(rect);
  return () => spy.mockRestore();
}

/** The pattern grid SVG (`aria-label="圖形鎖定"`). */
export function patternGrid(): HTMLElement {
  return screen.getByLabelText("圖形鎖定");
}

/** Drag through `dots` in order: press on the first, move over the rest, release. */
export function drawPattern(dots: number[]): void {
  const grid = patternGrid();
  const [first, ...rest] = dots;
  const start = patternDotCenter(first);
  fireEvent.mouseDown(grid, { clientX: start.x, clientY: start.y });
  for (const dot of rest) {
    const pos = patternDotCenter(dot);
    fireEvent.mouseMove(window, { clientX: pos.x, clientY: pos.y });
  }
  fireEvent.mouseUp(window);
}

/** Text of the "已連接 N 個點" counter, the user-visible selection state. */
export function connectedDotsText(): string {
  return screen.getByText(/已連接/).textContent ?? "";
}
