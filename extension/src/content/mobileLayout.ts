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

import { MOBILE_MEDIA_QUERY } from "../hooks/breakpoints";
import { MOO_ELEMENT_IDS } from "../utils/extensionContext";

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
  maxWidth: "640px",
  maxHeight: "80vh",
  borderRadius: "12px",
};

const MOBILE_DIALOG_STYLE: Record<string, string> = {
  top: "0",
  left: "0",
  transform: "none",
  width: "100vw",
  maxWidth: "100vw",
  maxHeight: "100vh",
  borderRadius: "0",
};

/** Switch the dialog container between desktop (centred card) and mobile (full screen). */
export function applyDialogLayout(dialog: HTMLElement, isMobile: boolean): void {
  const style = isMobile ? MOBILE_DIALOG_STYLE : DESKTOP_DIALOG_STYLE;
  for (const [prop, value] of Object.entries(style)) {
    dialog.style.setProperty(camelToKebab(prop), value);
  }
}

/**
 * On mobile the dialog fills the viewport, so the dimmed backdrop adds nothing
 * and would only sit behind the opaque dialog — hide it. Desktop keeps it.
 */
export function applyBackdropLayout(backdrop: HTMLElement, isMobile: boolean): void {
  backdrop.style.display = isMobile ? "none" : "block";
}

const CLOSE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/**
 * Build the mobile-only close button. It reuses the dialog's existing close
 * logic via `onClose` — it does not implement its own teardown. Hidden on
 * desktop (where the backdrop click already closes the dialog).
 */
export function createCloseIcon(onClose: () => void, isMobile: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = MOO_ELEMENT_IDS.closeIcon;
  button.type = "button";
  button.setAttribute("aria-label", "關閉");
  button.title = "關閉";
  button.innerHTML = CLOSE_ICON_SVG;
  button.style.cssText = [
    "position: absolute",
    "top: 8px",
    "right: 8px",
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
 * - Mobile: relocated next to the Readmoo header overflow (⋯) button so it does
 *   not overlap the mobile bottom tab bar. The header DOM is volatile, so when
 *   the anchor cannot be found we fall back to the desktop bottom-right
 *   position rather than breaking entirely.
 *
 * The button stays in `document.body` in both cases; only its fixed coordinates
 * change. Returns true when the mobile anchor was found and used.
 */
export function placeFloatingButton(button: HTMLElement, isMobile: boolean): boolean {
  if (!isMobile) {
    applyInlineStyles(button, DESKTOP_BUTTON_POSITION);
    return false;
  }

  const anchorRect = findHeaderOverflowRect();
  if (!anchorRect) {
    applyInlineStyles(button, DESKTOP_BUTTON_POSITION);
    return false;
  }

  const gap = 8;
  const top = Math.max(anchorRect.top, 4);
  const right = Math.max(window.innerWidth - anchorRect.left + gap, 4);
  applyInlineStyles(button, {
    position: "fixed",
    bottom: "auto",
    left: "auto",
    top: `${top}px`,
    right: `${right}px`,
  });
  return true;
}

/**
 * Locate the Readmoo header overflow / menu trigger. Tries a few resilient
 * selectors; returns its bounding rect, or null when none match.
 */
function findHeaderOverflowRect(): DOMRect | null {
  const selectors = [
    "header [class~='overflow']",
    "header button[aria-haspopup]",
    "header [aria-label*='選單']",
    "header [aria-label*='menu' i]",
    ".navbar [class~='overflow']",
    "#header [class*='dropdown-toggle']",
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement && isVisible(el)) {
      return el.getBoundingClientRect();
    }
  }
  return null;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function applyInlineStyles(el: HTMLElement, styles: Record<string, string>): void {
  for (const [prop, value] of Object.entries(styles)) {
    el.style.setProperty(camelToKebab(prop), value);
  }
}

function camelToKebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}
