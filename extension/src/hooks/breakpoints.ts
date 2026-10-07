/** Single source of truth for breakpoints, read by React (`useIsMobile`) and the content script
 *  (`matchMedia`). 767px matches Readmoo's own mobile-layout cutoff (e.g. Firefox Android ~375px). */

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
