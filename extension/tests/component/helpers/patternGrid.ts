import { vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

/** Geometry mirror of `extension/src/dialog/patternGeometry.ts` (3 × 3 dots on a 200 × 200 viewBox);
 *  why it is duplicated: see PATTERN_SVG_SIZE's JSDoc. */
const GRID_SIZE = 3;
/**
 * Side of the Dialog pattern SVG viewBox. The helper mirrors the production geometry instead of
 * importing it, so a dot that moves makes the hit tests here miss and the tests fail loudly.
 */
export const PATTERN_SVG_SIZE = 200;
const SPACING = PATTERN_SVG_SIZE / GRID_SIZE;

/** Centre of dot `index` in client pixels once the box is stubbed 1:1 (grid 0-1-2 / 3-4-5 / 6-7-8). */
export function patternDotCenter(index: number): {
  clientX: number;
  clientY: number;
} {
  return {
    clientX: (index % GRID_SIZE) * SPACING + SPACING / 2,
    clientY: Math.floor(index / GRID_SIZE) * SPACING + SPACING / 2,
  };
}

/** The pattern grid SVG (`role="application"`, `aria-label="圖形鎖"`). */
export function patternGrid(): HTMLElement {
  return screen.getByRole("application");
}

/**
 * Drag through `dots` in order — press on the first, move over the rest, release — on the grid
 * SVG. jsdom reports a zero-sized box, so `getBoundingClientRect` is stubbed to the viewBox for the
 * duration of the gesture and restored before returning (the component reads it synchronously).
 */
export function drawPattern(dots: readonly number[]): void {
  const grid = patternGrid();
  const spy = vi.spyOn(grid, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: PATTERN_SVG_SIZE,
    bottom: PATTERN_SVG_SIZE,
    width: PATTERN_SVG_SIZE,
    height: PATTERN_SVG_SIZE,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  try {
    const [first, ...rest] = dots;
    if (first === undefined) return;
    fireEvent.mouseDown(grid, patternDotCenter(first));
    for (const dot of rest) fireEvent.mouseMove(grid, patternDotCenter(dot));
    fireEvent.mouseUp(grid);
  } finally {
    spy.mockRestore();
  }
}

/**
 * The PatternLock's own 確認 button, scoped to the widget root (`.moo-secret-entry`) so a screen
 * that renders other 確認 buttons cannot make the query ambiguous.
 */
export function patternConfirmButton(): HTMLElement {
  const root = patternGrid().closest(".moo-secret-entry");
  if (!(root instanceof HTMLElement)) {
    throw new Error("PatternLock root .moo-secret-entry not found");
  }
  return within(root).getByRole("button", { name: "確認" });
}

/** Text of the "已連接 N 個點" counter, the user-visible selection state. */
export function connectedDotsText(): string {
  return screen.getByText(/已連接/).textContent ?? "";
}
