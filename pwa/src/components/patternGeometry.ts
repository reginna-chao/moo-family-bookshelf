/** Grid geometry of the PWA's PatternLock: a 3 × 3 dot grid laid out row-major. */

export const GRID_SIZE = 3;
export const DOT_COUNT = GRID_SIZE * GRID_SIZE;

/** Grid layout: 0-1-2 / 3-4-5 / 6-7-8 */
export function dotPosition(
  index: number,
  cellSize: number,
  padding: number,
): { cx: number; cy: number } {
  const col = index % GRID_SIZE;
  const row = Math.floor(index / GRID_SIZE);
  return {
    cx: padding + col * cellSize + cellSize / 2,
    cy: padding + row * cellSize + cellSize / 2,
  };
}
