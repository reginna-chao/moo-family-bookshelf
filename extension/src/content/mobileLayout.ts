/**
 * Mobile-only layout helpers for the content-script-injected MooFamily UI.
 *
 * The content script runs outside React, so responsive behaviour is driven by
 * `window.matchMedia(MOBILE_MEDIA_QUERY)` rather than `useMediaQuery`. Every
 * listener registered here is tracked so it can be torn down on dialog close,
 * button removal, or extension-context invalidation (see `stopAllMobileWatchers`).
 *
 * Desktop layout (> 600px) is intentionally left untouched: each `apply*`
 * helper writes the original desktop values in its non-mobile branch.
 */

import {
  MOBILE_MEDIA_QUERY,
  SMALL_PHONE_BREAKPOINT_PX,
} from "../hooks/breakpoints";
import { MOO_ELEMENT_IDS } from "../utils/extensionContext";

/** Gap between the floating button and the Readmoo bottom nav, in CSS pixels. */
const FLOATING_BUTTON_GAP_PX = 12;

/** Fallback height of Readmoo's single-line bottom nav (wider phones). */
const BOTTOM_NAV_HEIGHT_PX = 55;

/** Fallback height of Readmoo's two-line bottom nav (phones ≤ 370px). */
const BOTTOM_NAV_HEIGHT_SMALL_PX = 76;

/**
 * A measured nav candidate is only trusted as the bottom tab bar when it spans
 * most of the viewport width and sits near the very bottom of the viewport.
 */
const BOTTOM_NAV_MIN_WIDTH_RATIO = 0.6;
const BOTTOM_NAV_MAX_BOTTOM_GAP_PX = 4;

type MobileListener = (isMobile: boolean) => void;

interface MobileWatcher {
  mql: MediaQueryList;
  handler: () => void;
}

const activeWatchers = new Set<MobileWatcher>();

/**
 * Subscribe to mobile-breakpoint changes. Invokes `onChange` immediately with
 * the current state, then on every change. Returns a disposer that removes the
 * listener; the watcher is also tracked for `stopAllMobileWatchers`.
 */
export function watchMobile(onChange: MobileListener): () => void {
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  const handler = (): void => onChange(mql.matches);

  const watcher: MobileWatcher = { mql, handler };
  mql.addEventListener("change", handler);
  activeWatchers.add(watcher);

  onChange(mql.matches);

  return () => {
    mql.removeEventListener("change", handler);
    activeWatchers.delete(watcher);
  };
}

/** Remove every registered mobile watcher. Safe to call repeatedly. */
export function stopAllMobileWatchers(): void {
  for (const watcher of activeWatchers) {
    watcher.mql.removeEventListener("change", watcher.handler);
  }
  activeWatchers.clear();
}

const DESKTOP_DIALOG_STYLE: Record<string, string> = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "90vw",
  height: "80vh",
  maxWidth: "640px",
  maxHeight: "80vh",
  borderRadius: "12px",
};

const MOBILE_DIALOG_STYLE: Record<string, string> = {
  top: "0",
  left: "0",
  transform: "none",
  width: "100vw",
  height: "100vh",
  maxWidth: "100vw",
  maxHeight: "100vh",
  borderRadius: "0",
};

/** Switch the dialog container between desktop (centred card) and mobile (full screen). */
export function applyDialogLayout(
  dialog: HTMLElement,
  isMobile: boolean,
): void {
  const style = isMobile ? MOBILE_DIALOG_STYLE : DESKTOP_DIALOG_STYLE;
  for (const [prop, value] of Object.entries(style)) {
    dialog.style.setProperty(camelToKebab(prop), value);
  }
}

/**
 * On mobile the dialog fills the viewport, so the dimmed backdrop adds nothing
 * and would only sit behind the opaque dialog — hide it. Desktop keeps it.
 */
export function applyBackdropLayout(
  backdrop: HTMLElement,
  isMobile: boolean,
): void {
  backdrop.style.display = isMobile ? "none" : "block";
}

const CLOSE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/**
 * Build the mobile-only close button. It reuses the dialog's existing close
 * logic via `onClose` — it does not implement its own teardown. Hidden on
 * desktop (where the backdrop click already closes the dialog).
 */
export function createCloseIcon(
  onClose: () => void,
  isMobile: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = MOO_ELEMENT_IDS.closeIcon;
  button.type = "button";
  button.setAttribute("aria-label", "關閉");
  button.title = "關閉";
  button.innerHTML = CLOSE_ICON_SVG;
  button.style.cssText = [
    "position: absolute",
    "top: 2px",
    "right: 4px",
    "z-index: 1",
    "width: 32px",
    "height: 32px",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "padding: 0",
    "border: none",
    "border-radius: 8px",
    "background: transparent",
    "color: #64748b",
    "cursor: pointer",
  ].join(";");
  button.style.display = isMobile ? "inline-flex" : "none";
  button.addEventListener("click", onClose);
  return button;
}

const DESKTOP_BUTTON_POSITION: Record<string, string> = {
  position: "fixed",
  top: "auto",
  bottom: "24px",
  right: "24px",
  left: "auto",
};

/**
 * Position the floating "家庭書櫃" button.
 *
 * - Desktop: bottom-right of the viewport (original behaviour).
 * - Mobile: bottom-right, but lifted above the Readmoo bottom tab bar so it does
 *   not overlap. The bar's height is measured at runtime, so the lift adapts to
 *   both the single-line bar and the taller two-line bar on small phones. When
 *   the bar cannot be located, a width-based fallback height is used.
 *
 * The button stays in `document.body` in both cases; only its fixed coordinates
 * change. Returns true when the bottom nav was measured (vs. the fallback).
 */
export function placeFloatingButton(
  button: HTMLElement,
  isMobile: boolean,
): boolean {
  if (!isMobile) {
    applyInlineStyles(button, DESKTOP_BUTTON_POSITION);
    return false;
  }

  const measuredNavHeight = findBottomNavHeight();
  const navHeight = measuredNavHeight ?? fallbackNavHeight();
  applyInlineStyles(button, {
    position: "fixed",
    top: "auto",
    left: "auto",
    right: "24px",
    bottom: `${navHeight + FLOATING_BUTTON_GAP_PX}px`,
  });
  return measuredNavHeight !== null;
}

/** Fallback bottom-nav height based on viewport width when measurement fails. */
function fallbackNavHeight(): number {
  return window.innerWidth <= SMALL_PHONE_BREAKPOINT_PX
    ? BOTTOM_NAV_HEIGHT_SMALL_PX
    : BOTTOM_NAV_HEIGHT_PX;
}

/**
 * Measure the rendered height of the Readmoo bottom tab bar.
 *
 * Readmoo's actual bottom bar (`.main-menu`) is tried first, ahead of a small
 * allowlist of generic guesses kept as a fallback in case the class names
 * change. Each candidate is validated to actually look like a bottom bar (spans
 * most of the viewport width, sits at the viewport bottom) before being
 * trusted. Returns the height in CSS pixels, or null when no candidate
 * qualifies so the caller can fall back to a hardcoded height.
 */
function findBottomNavHeight(): number | null {
  const selectors = [
    // `.main-menu` is Readmoo's actual bottom tab bar; `.nav.nav-justified` is a
    // defensive secondary class on the SAME element (kept in case `main-menu`
    // changes). The rest are generic fallbacks; all are validated by `isBottomBar`.
    ".main-menu",
    ".nav.nav-justified",
    "nav[class*='bottom']",
    "footer nav",
    ".bottom-nav",
    ".tabbar",
    ".tab-bar",
    "[class*='bottom-navigation']",
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement && isBottomBar(el)) {
      return el.getBoundingClientRect().height;
    }
  }
  return null;
}

/**
 * A candidate qualifies as the bottom tab bar when it has a non-zero size,
 * spans most of the viewport width, and its bottom edge sits at (or just above)
 * the viewport bottom.
 */
function isBottomBar(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const spansWidth =
    rect.width >= window.innerWidth * BOTTOM_NAV_MIN_WIDTH_RATIO;
  const atBottom =
    Math.abs(rect.bottom - window.innerHeight) <= BOTTOM_NAV_MAX_BOTTOM_GAP_PX;
  return spansWidth && atBottom;
}

function applyInlineStyles(
  el: HTMLElement,
  styles: Record<string, string>,
): void {
  for (const [prop, value] of Object.entries(styles)) {
    el.style.setProperty(camelToKebab(prop), value);
  }
}

function camelToKebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
