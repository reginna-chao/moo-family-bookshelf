/** Mobile layout for the content-script UI (outside React, so `matchMedia`); every listener is tracked
 *  for teardown, desktop keeps its originals. See docs/architecture.md → 浮動按鈕與 Dialog 外殼. */

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

/** A measured nav candidate is trusted as the bottom tab bar only when it spans most of the viewport
 *  width and sits near its very bottom. */
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

/** Desktop card height ceiling; the main view's fixed height equals this cap. */
const DESKTOP_MAX_HEIGHT = "80vh";

/** Desktop card geometry minus `height`: the fixed 80vh goes on the main view only, so onboarding /
 *  loading fit their content (capped by maxHeight, floored by min-height) with no tall blank gap. */
const DESKTOP_DIALOG_BASE_STYLE: Record<string, string> = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "90vw",
  maxWidth: "650px",
  maxHeight: DESKTOP_MAX_HEIGHT,
  borderRadius: "12px",
};

/** Fixed desktop main-view height (no jump between tabs), equal to the card's max-height cap. */
const DESKTOP_MAIN_HEIGHT = DESKTOP_MAX_HEIGHT;

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

/**
 * Switch the dialog container between desktop (centred card) and mobile (full
 * screen). On desktop, only the main view gets a fixed `height: 80vh`; other
 * views (onboarding/loading) drop the explicit height so the card fits content.
 */
export function applyDialogLayout(
  dialog: HTMLElement,
  isMobile: boolean,
  isMainView = false,
): void {
  if (isMobile) {
    applyStyleMap(dialog, MOBILE_DIALOG_STYLE);
    return;
  }

  applyStyleMap(dialog, DESKTOP_DIALOG_BASE_STYLE);
  if (isMainView) {
    dialog.style.setProperty("height", DESKTOP_MAIN_HEIGHT);
  } else {
    // Clear any height left over from a previous main/mobile layout so the
    // desktop card collapses back to its content height.
    dialog.style.removeProperty("height");
  }
}

function applyStyleMap(
  dialog: HTMLElement,
  style: Record<string, string>,
): void {
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
  // Static styles: SHELL_BOOTSTRAP_CSS (`.moo-shell-close`, injected first; id kept for E2E). Only the
  // per-breakpoint `display` stays inline — the class omits it so the two never fight.
  button.className = "moo-shell-close";
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

/** Rendered height (CSS px) of Readmoo's bottom tab bar — the first candidate `isBottomBar` accepts —
 *  or null so the caller uses the hardcoded fallback height. */
function findBottomNavHeight(): number | null {
  const selectors = [
    // `.main-menu` is Readmoo's real bar, `.nav.nav-justified` a second class on the SAME element (in
    // case `main-menu` changes); the rest are generic guesses in case the class names change.
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

/** A candidate is the bottom tab bar when it has a non-zero size, spans most of the viewport width, and
 *  its bottom edge sits at (or just above) the viewport bottom. */
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
