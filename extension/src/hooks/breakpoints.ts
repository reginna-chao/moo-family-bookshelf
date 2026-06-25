/**
 * Single source of truth for responsive breakpoints.
 *
 * Consumed by both React (via `useIsMobile`) and the non-React content script
 * (via `window.matchMedia(MOBILE_MEDIA_QUERY)`), so the mobile cutoff is defined
 * exactly once. The Readmoo site renders its mobile layout on small viewports
 * (e.g. Firefox Android ~375px); 767px is the agreed cutoff. To fit the Readmoo's breakpoint settings.
 */

/** Mobile breakpoint in CSS pixels. Viewports at or below this are "mobile". */
export const MOBILE_BREAKPOINT_PX = 767;

/** Media query string matching mobile viewports. */
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

/**
 * Viewports at or below this width get Readmoo's two-line bottom tab bar, which
 * is taller than the single-line bar shown on wider phones. Used only as the
 * fallback cutoff when the bottom nav element cannot be measured at runtime.
 */
export const SMALL_PHONE_BREAKPOINT_PX = 370;
