import { useMediaQuery } from "./useMediaQuery";
import { MOBILE_MEDIA_QUERY } from "./breakpoints";

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 *
 * Wraps `useMediaQuery` with the single-source-of-truth mobile query so Dialog
 * components can branch on `isMobile` without repeating the query string.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_MEDIA_QUERY);
}
