/** Content Script on Readmoo pages: injects the "家庭書櫃" button and mounts the Dialog on click.
 *  Shell lifecycle: docs/architecture.md → 浮動按鈕與 Dialog 外殼. */

// The scraper is bundled twice on purpose (this IIFE via ./profileCache, the ESM content-sync module
// via syncBooks.ts): it is stateless — reads the DOM, holds no shared mutable state.
import browser from "webextension-polyfill";
import { tryScrapeAndCacheEmail } from "./profileCache";
import {
  isExtensionContextValid,
  cleanupMooFamilyUI,
  MOO_ELEMENT_IDS,
} from "../utils/extensionContext";
import { waitForPageReady } from "./pageReady";
import { getAppEnv } from "../utils/appEnv";
import {
  watchMobile,
  stopAllMobileWatchers,
  applyDialogLayout,
  applyBackdropLayout,
  createCloseIcon,
  placeFloatingButton,
} from "./mobileLayout";
import { SHELL_BOOTSTRAP_CSS, SHELL_STYLE_MARKER } from "./shellStyles";
import {
  updatePendingBorrowBadge,
  updateBadge,
  recheckBadgeIfDialogOpen,
} from "./pendingBorrowBadge";
import { FLOATING_ICON_SIZE_KEY } from "../constants";
import { isReadmooAppPath } from "moo-family-bookshelf-shared/config/readmoo";

const APP_ENV = getAppEnv();

/** The code-split dialog module loaded via getURL(); `mountDialog` returns an unmount handle that
 *  must be kept and called on close. */
type DialogModule = typeof import("../dialog/main");

/** Disposer for the floating button's breakpoint watcher (see injection). */
let disposeButtonWatcher: (() => void) | null = null;

/** Disposer for the open dialog's breakpoint watcher (see toggleDialog). */
let disposeDialogWatcher: (() => void) | null = null;

/** The dialog React root's unmount handle (from mountDialog), module-scoped because the mount and the
 *  teardown paths are separate calls sharing it across the open/close lifecycle. */
let unmountDialogApp: (() => void) | null = null;

/** Unmount the dialog's React root if mounted, then clear the handle; guarded so a failure never blocks
 *  DOM teardown. Removing the host alone would leak the root (its effects keep running). */
function unmountDialogRoot(): void {
  try {
    unmountDialogApp?.();
  } catch (err) {
    console.error("[MooFamily] Dialog unmount failed:", err);
  }
  unmountDialogApp = null;
}

/** Full dialog teardown — React root first (cleanups run while attached), dialog watcher, then the
 *  host; the button is untouched. See docs/architecture.md → 浮動按鈕與 Dialog 外殼. */
function disposeDialogShell(): void {
  unmountDialogRoot();
  disposeDialogWatcher?.();
  disposeDialogWatcher = null;
  document.getElementById(MOO_ELEMENT_IDS.host)?.remove();
}

/** Remove all MooFamily UI and stop every breakpoint watcher; the content script uses this, never bare
 *  `cleanupMooFamilyUI`, so no matchMedia listener is left dangling. */
function teardownMooFamilyUI(): void {
  // Unmount the React root before cleanupMooFamilyUI rips its host out of the DOM.
  unmountDialogRoot();
  disposeButtonWatcher = null;
  disposeDialogWatcher = null;
  stopAllMobileWatchers();
  cleanupMooFamilyUI();
}

type FloatingIconSize = "small" | "medium" | "large" | "icon";

export function getButtonSizeStyles(size: FloatingIconSize): {
  padding: string;
  fontSize: string;
} {
  if (size === "icon") return { padding: "10px", fontSize: "0px" };
  if (size === "small") return { padding: "6px 12px", fontSize: "12px" };
  if (size === "large") return { padding: "14px 24px", fontSize: "16px" };
  return { padding: "12px 20px", fontSize: "14px" };
}

export function isFloatingIconSize(value: unknown): value is FloatingIconSize {
  return (
    value === "small" ||
    value === "medium" ||
    value === "large" ||
    value === "icon"
  );
}

const BOOK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path fill-rule="evenodd" d="M3 22L3 11A9 9 0 0 1 21 11L21 22ZM5 21L5 11.5A7 7 0 0 1 19 11.5L19 21Z"/><rect x="5" y="15" width="14" height="1.2" rx=".2"/><rect x="6.5" y="9.5" width="2" height="5.5" rx=".5"/><rect x="10" y="10.5" width="2" height="4.5" rx=".5"/><path d="M15 14.8L15.5 12.8H17.5L18 14.8Z"/><path d="M16.5 12.8Q14.5 11 14.5 9.5Q15.5 10 16.5 12.8Z"/><path d="M16.5 12.8Q18.5 11 18.5 9.5Q17.5 10 16.5 12.8Z"/><path d="M16.5 12.8Q16.5 10.5 16 8.5Q17 8.5 16.5 12.8Z"/><rect x="5" y="20.5" width="14" height="1.2" rx=".2"/><rect x="6.5" y="16.5" width="2" height="4" rx=".5"/><rect x="10" y="17" width="2" height="3.5" rx=".5"/><rect x="13.5" y="16.5" width="2" height="4" rx=".5"/><rect x="16.5" y="17" width="1.8" height="3.5" rx=".5" transform="rotate(-10 17.4 18.8)"/></svg>`;

function applyButtonContent(button: HTMLElement, size: FloatingIconSize): void {
  if (size === "icon") {
    button.textContent = "";
    button.innerHTML = BOOK_ICON_SVG;
    button.title = "家庭書櫃";
  } else {
    button.innerHTML = "";
    button.textContent = "家庭書櫃";
    button.title = "";
  }
}

let envStyleInjected = false;
function injectEnvStyle(): void {
  if (envStyleInjected) return;
  envStyleInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    @property --moo-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    @keyframes moo-dev-rainbow {
      to { --moo-angle: 360deg; }
    }
    #${MOO_ELEMENT_IDS.button}.moo-env-local {
      border: 3px solid transparent !important;
      background:
        linear-gradient(#2563eb, #2563eb) padding-box,
        conic-gradient(from var(--moo-angle), #ff0000, #ff8800, #ffff00, #00ff00, #0088ff, #8800ff, #ff0000) border-box !important;
      animation: moo-dev-rainbow 2s linear infinite;
    }
    #${MOO_ELEMENT_IDS.button}.moo-env-dev {
      border: 2px solid #93c5fd !important;
    }
  `;
  document.head.appendChild(style);
}

let baseButtonStyleInjected = false;
// All environments (injectEnvStyle is dev-only); `@media (hover: hover)` avoids sticky hover on touch.
// cleanupMooFamilyUI leaves this <style> behind, so the module flag blocks duplicate injection.
function injectBaseButtonStyle(): void {
  if (baseButtonStyleInjected) return;
  baseButtonStyleInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    @media (hover: hover) {
      #${MOO_ELEMENT_IDS.button}:hover {
        opacity: 0.8;
      }
    }
  `;
  document.head.appendChild(style);
}

async function injectFamilyBookshelfButton(): Promise<void> {
  if (!isExtensionContextValid()) {
    teardownMooFamilyUI();
    return;
  }

  // Avoid duplicate injection
  if (document.getElementById(MOO_ELEMENT_IDS.button)) return;

  // Read stored size (default to medium if missing/invalid)
  let size: FloatingIconSize = "medium";
  try {
    const stored = await browser.storage.local.get([FLOATING_ICON_SIZE_KEY]);
    if (isFloatingIconSize(stored[FLOATING_ICON_SIZE_KEY])) {
      size = stored[FLOATING_ICON_SIZE_KEY];
    }
  } catch {
    // fallback to medium
  }
  const { padding, fontSize } = getButtonSizeStyles(size);

  const button = document.createElement("button");
  button.id = MOO_ELEMENT_IDS.button;
  applyButtonContent(button, size);
  button.style.cssText = [
    "position: fixed",
    "bottom: 24px",
    "right: 24px",
    "z-index: 99999",
    `padding: ${padding}`,
    "border-radius: 8px",
    "border: none",
    "background: #2563eb",
    "color: white",
    `font-size: ${fontSize}`,
    "font-weight: 600",
    "cursor: pointer",
    "box-shadow: 0 2px 8px rgba(0,0,0,0.15)",
    "font-family: -apple-system, BlinkMacSystemFont, sans-serif",
    "transition: opacity 0.2s ease-in",
  ].join(";");

  injectBaseButtonStyle();

  if (APP_ENV !== "prod") {
    injectEnvStyle();
    button.classList.add(`moo-env-${APP_ENV}`);
  }

  button.addEventListener("click", toggleDialog);
  document.body.appendChild(button);

  // Bottom-right; on mobile lifted above Readmoo's bottom tab bar (placeFloatingButton). The module-level
  // disposer lets re-injection / cleanup tear the watcher down (no leaked listener).
  disposeButtonWatcher?.();
  disposeButtonWatcher = watchMobile((isMobile) => {
    placeFloatingButton(button, isMobile);
  });

  // Best-effort: query pending borrow requests and badge the button.
  // Failures are silent — the badge is a non-essential nicety.
  void updatePendingBorrowBadge(button);
}

/** Inject the shell bootstrap stylesheet into the shadow root (idempotent via its marker, like
 *  mountDialog's); kept apart from styles.css so the content-script IIFE never bundles that. */
function injectShellStyles(shadowRoot: ShadowRoot): void {
  if (shadowRoot.querySelector(`style[${SHELL_STYLE_MARKER}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(SHELL_STYLE_MARKER, "");
  style.textContent = SHELL_BOOTSTRAP_CSS;
  shadowRoot.appendChild(style);
}

function toggleDialog(): void {
  if (!isExtensionContextValid()) {
    teardownMooFamilyUI();
    return;
  }

  // "Already open?" checks the light-DOM host: the dialog/backdrop live in its shadow tree, out of
  // document.getElementById's reach.
  const existingHost = document.getElementById(MOO_ELEMENT_IDS.host);
  if (existingHost) {
    // Toggle off disposes ONLY the dialog's watcher; the floating button's must survive so the
    // button keeps repositioning on later breakpoint changes.
    disposeDialogShell();
    return;
  }

  // Opening a fresh dialog: defensively clear any stale React root handle so we
  // never orphan a root across open/close cycles (e.g. if a prior close raced).
  unmountDialogRoot();

  const dialog = document.createElement("div");
  dialog.id = MOO_ELEMENT_IDS.dialog;
  // Static styles: SHELL_BOOTSTRAP_CSS (`.moo-shell-dialog`), injected first so no unstyled flash; the
  // id stays for getElementById / E2E; per-breakpoint geometry is JS-driven (applyDialogLayout).
  dialog.className = "moo-shell-dialog";

  // Backdrop — static full-viewport overlay via `.moo-shell-backdrop`; its
  // mobile/desktop `display` toggle stays inline via applyBackdropLayout.
  const backdrop = document.createElement("div");
  backdrop.id = MOO_ELEMENT_IDS.backdrop;
  backdrop.className = "moo-shell-backdrop";

  // Light-DOM host owning the Shadow Root: a plain div (no stacking context / transform), so the fixed
  // backdrop/dialog inside still cover the viewport. Toggle-off / invalidation paths remove it.
  const host = document.createElement("div");
  host.id = MOO_ELEMENT_IDS.host;
  const shadowRoot = host.attachShadow({ mode: "open" });

  // Must run before backdrop/dialog are appended, so they never flash unstyled.
  injectShellStyles(shadowRoot);

  // Single close path (backdrop click + mobile close icon): the same disposeDialogShell teardown as
  // toggle-off; the button watcher is separate.
  const closeDialog = (): void => {
    disposeDialogShell();
  };
  backdrop.addEventListener("click", closeDialog);

  // Mobile-only close icon (top-right). Reuses closeDialog; hidden on desktop.
  const closeIcon = createCloseIcon(closeDialog, false);
  dialog.appendChild(closeIcon);

  // Mount point for React app — static flex-column fill via `.moo-shell-mount`.
  const mountPoint = document.createElement("div");
  mountPoint.id = MOO_ELEMENT_IDS.root;
  mountPoint.className = "moo-shell-mount";
  dialog.appendChild(mountPoint);

  // Backdrop + dialog go INTO the shadow root (isolated from Readmoo CSS), then the host onto the
  // page; mountDialog injects the scoped stylesheet into this root (container.getRootNode()).
  shadowRoot.appendChild(backdrop);
  shadowRoot.appendChild(dialog);
  document.body.appendChild(host);

  // Latest breakpoint + view (starts non-main, then onViewChange); a change to either re-applies the
  // layout. Only the desktop main view uses the fixed 80vh height (applyDialogLayout).
  let currentIsMobile = false;
  let currentIsMainView = false;

  const relayout = (): void => {
    applyDialogLayout(dialog, currentIsMobile, currentIsMainView);
    applyBackdropLayout(backdrop, currentIsMobile);
    closeIcon.style.display = currentIsMobile ? "inline-flex" : "none";
  };

  // Full-screen (mobile) vs centred card (desktop); disposed on every close (closeDialog / toggle-off),
  // and any stale watcher is disposed first.
  disposeDialogWatcher?.();
  disposeDialogWatcher = watchMobile((isMobile) => {
    currentIsMobile = isMobile;
    relayout();
  });

  // Isolated-world content scripts cannot resolve standard ES module imports, so code-split modules
  // load via runtime.getURL() (web-accessible resources).
  import(/* @vite-ignore */ browser.runtime.getURL("content-dialog.js"))
    .then((mod: DialogModule) => {
      // Race guard: the dialog may have closed before this import resolved; mounting into a detached
      // point would leak a root nobody holds.
      if (!mountPoint.isConnected) return;
      // Retain the unmount handle so the close/teardown paths can release the root.
      unmountDialogApp = mod.mountDialog(mountPoint, {
        onViewChange: (view) => {
          currentIsMainView = view === "main";
          relayout();
        },
        // Keep the button badge in step with live borrow changes while open (the button stays in the
        // light DOM, so look it up by id).
        onPendingBorrowCountChange: (count) => {
          const button = document.getElementById(MOO_ELEMENT_IDS.button);
          if (button) updateBadge(button, count);
        },
      });
    })
    .catch((err) => {
      console.error("[MooFamily] Failed to load dialog module:", err);
      mountPoint.textContent = "載入失敗，請重新整理頁面再試。";
    });
}

let currentAbortController: AbortController | null = null;

/** Abort any pending wait; re-inject the 家庭書櫃 button in the reader app only. */
function waitAndInjectButton(): void {
  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  // Remove existing button for hashchange re-injection. Dispose its breakpoint
  // watcher first so the stale listener does not outlive the removed button.
  disposeButtonWatcher?.();
  disposeButtonWatcher = null;
  document.getElementById(MOO_ELEMENT_IDS.button)?.remove();
  if (!isReadmooAppPath(location.hostname, location.pathname)) return;

  waitForPageReady(controller.signal)
    .then(() => void injectFamilyBookshelfButton())
    .catch((err: unknown) => {
      // AbortError means a new navigation cancelled this wait — silently ignore
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[MooFamily] Page ready detection failed:", err);
    });
}

/** Apply floatingIconSize changes to the existing button in place — re-injection would lose the
 *  badge state. */
function listenForIconSizeChanges(): void {
  if (!isExtensionContextValid()) return;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[FLOATING_ICON_SIZE_KEY]) return;
    const newValue = changes[FLOATING_ICON_SIZE_KEY].newValue;
    const size: FloatingIconSize = isFloatingIconSize(newValue)
      ? newValue
      : "medium";
    const button = document.getElementById(MOO_ELEMENT_IDS.button);
    if (!button) return;
    const { padding, fontSize } = getButtonSizeStyles(size);
    button.style.padding = padding;
    button.style.fontSize = fontSize;
    applyButtonContent(button, size);
  });
}

// Run on page load
if (!isExtensionContextValid()) {
  teardownMooFamilyUI();
} else {
  const init = (): void => {
    waitAndInjectButton();
    tryScrapeAndCacheEmail();
    listenForIconSizeChanges();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("hashchange", () => {
    if (!recheckBadgeIfDialogOpen()) waitAndInjectButton();
    tryScrapeAndCacheEmail();
  });
}
