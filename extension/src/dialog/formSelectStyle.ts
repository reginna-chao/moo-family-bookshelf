import type { CSSProperties } from "react";

/**
 * Shared inline style for native `<select className="moo-form-select">` elements.
 *
 * The only responsive difference is vertical padding: mobile trims the combined
 * top+bottom padding by 6px (8px -> 5px each side) to fit tighter viewports,
 * while left/right padding stays 12px on both breakpoints. `width` is left to the
 * call site so auto-width and full-width selects can share this base.
 */
export function formSelectStyle(isMobile: boolean): CSSProperties {
  const padding = isMobile ? "5px 12px" : "8px 12px";
  return {
    padding,
    paddingRight: "2.25rem",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    fontSize: 14,
    backgroundColor: "white",
    color: "#334155",
    cursor: "pointer",
    outline: "none",
  };
}
