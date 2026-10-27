/** Grid geometry of the Dialog's PatternLock (3 × 3 dots on a 200 × 200 viewBox). */

const GRID_SIZE = 3;
export const DOT_COUNT = GRID_SIZE * GRID_SIZE;
export const CANVAS_SIZE = 200;
export const DOT_RADIUS = 12;
const DOT_SPACING = CANVAS_SIZE / GRID_SIZE;
const DOT_OFFSET = DOT_SPACING / 2;

/** Centre of dot `index` (row-major: 0-1-2 / 3-4-5 / 6-7-8) in viewBox units. */
export function getDotCenter(index: number): { x: number; y: number } {
  const col = index % GRID_SIZE;
  const row = Math.floor(index / GRID_SIZE);
  return {
    x: col * DOT_SPACING + DOT_OFFSET,
    y: row * DOT_SPACING + DOT_OFFSET,
  };
}

/** Index of the dot within 1.5 × `DOT_RADIUS` of a viewBox point, or null when none is. */
export function getIndexFromPosition(x: number, y: number): number | null {
  for (let i = 0; i < DOT_COUNT; i++) {
    const center = getDotCenter(i);
    const dist = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2);
    if (dist <= DOT_RADIUS * 1.5) return i;
  }
  return null;
}
