/**
 * Single source of truth for responsive breakpoints.
 *
 * Consumed by both React (via `useIsMobile`) and the non-React content script
 * (via `window.matchMedia(MOBILE_MEDIA_QUERY)`), so the mobile cutoff is defined
 * exactly once. The Readmoo site renders its mobile layout on small viewports
 * (e.g. Firefox Android ~375px); 600px is the agreed cutoff.
 */

/** Mobile breakpoint in CSS pixels. Viewports at or below this are "mobile". */
export const MOBILE_BREAKPOINT_PX = 600;

/** Media query string matching mobile viewports. */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
