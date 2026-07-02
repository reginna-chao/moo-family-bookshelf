import type { CSSProperties } from "react";

/**
 * Shared inline style for native `<select className="moo-form-select">` elements.
 *
 * Height is pinned to match the toolbar icon buttons (`.moo-view-toggle__btn`,
 * `.moo-sort__trigger`): 40px desktop / 32px mobile. Selects center their text
 * natively, so we drop explicit vertical padding and rely on the fixed height
 * (with border-box so the border is included). Horizontal padding stays 12px;
 * `paddingRight` leaves room for the native chevron. `width` is left to the call
 * site so auto-width and full-width selects can share this base.
 */
export function formSelectStyle(isMobile: boolean): CSSProperties {
  const height = isMobile ? 32 : 40;
  return {
    boxSizing: "border-box",
    height,
    padding: "0 12px",
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
