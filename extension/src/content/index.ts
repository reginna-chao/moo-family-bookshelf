/**
 * Content Script — injected into Readmoo pages.
 * Responsibilities:
 * 1. Inject the "家庭書櫃" button into the page
 * 2. Mount the Dialog UI when button is clicked
 */

// The scraper module is statically imported here (bundled into the content script IIFE)
// and also imported by syncBooks.ts (bundled into the ESM content-sync module).
// This intentional duplication is safe because the scraper is stateless — it only
// reads DOM elements and returns data, with no shared mutable state.
import browser from "webextension-polyfill";
import { scrapeUserEmail, scrapeDisplayName } from "./scraper";
import { isExtensionContextValid, cleanupMooFamilyUI, MOO_ELEMENT_IDS } from "../utils/extensionContext";
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
  DEFAULT_API_ENDPOINT,
  FLOATING_ICON_SIZE_KEY,
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  API_ENDPOINT_KEY,
  USER_EMAIL_KEY,
  DISPLAY_NAME_KEY,
} from "../constants";
import { BorrowStatus, type BorrowRequest } from "../api/types";

const APP_ENV = getAppEnv();

/**
 * Shape of the code-split dialog module loaded at runtime via getURL().
 * `mountDialog` returns an unmount handle we must retain and call on close.
 */
type DialogModule = typeof import("../dialog/main");

/** Disposer for the floating button's breakpoint watcher (see injection). */
let disposeButtonWatcher: (() => void) | null = null;

/** Disposer for the open dialog's breakpoint watcher (see toggleDialog). */
let disposeDialogWatcher: (() => void) | null = null;

/**
 * Unmount handle for the dialog's React root, returned by mountDialog. Held at
 * module scope because mount (inside a dynamic import) and the teardown paths
 * are separate calls that must share it across the open/close lifecycle.
 */
let unmountDialogApp: (() => void) | null = null;

/**
 * Unmount the dialog's React root if one is mounted, then clear the handle.
 * Guarded: an unmount failure must never block the surrounding DOM teardown.
 * Removing the host DOM alone would leak the root (its effects keep running).
 */
function unmountDialogRoot(): void {
  try {
    unmountDialogApp?.();
  } catch (err) {
    console.error("[MooFamily] Dialog unmount failed:", err);
  }
  unmountDialogApp = null;
}

/**
 * Full dialog teardown: unmount the React root FIRST (so effects/cleanups run
 * while the DOM is still attached), dispose the dialog breakpoint watcher, then
 * remove the host. Shared by the toggle-off and close (backdrop / mobile icon)
 * paths so the three-step order lives in exactly one place. The floating button
 * and its badge are untouched (separate light-DOM element).
 */
function disposeDialogShell(): void {
  unmountDialogRoot();
  disposeDialogWatcher?.();
  disposeDialogWatcher = null;
  document.getElementById(MOO_ELEMENT_IDS.host)?.remove();
}

/**
 * Remove all MooFamily UI and stop every breakpoint watcher. Use this instead
 * of `cleanupMooFamilyUI` from the content script so matchMedia listeners are
 * never left dangling after teardown.
 */
function teardownMooFamilyUI(): void {
  // Unmount the React root before cleanupMooFamilyUI rips its host out of the DOM.
  unmountDialogRoot();
  disposeButtonWatcher = null;
  disposeDialogWatcher = null;
  stopAllMobileWatchers();
  cleanupMooFamilyUI();
}

type FloatingIconSize = "small" | "medium" | "large" | "icon";

export function getButtonSizeStyles(size: FloatingIconSize): { padding: string; fontSize: string } {
  if (size === "icon") return { padding: "10px", fontSize: "0px" };
  if (size === "small") return { padding: "6px 12px", fontSize: "12px" };
  if (size === "large") return { padding: "14px 24px", fontSize: "16px" };
  return { padding: "12px 20px", fontSize: "14px" };
}

export function isFloatingIconSize(value: unknown): value is FloatingIconSize {
  return value === "small" || value === "medium" || value === "large" || value === "icon";
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
  ].join(";");

  if (APP_ENV !== "prod") {
    injectEnvStyle();
    button.classList.add(`moo-env-${APP_ENV}`);
  }

  button.addEventListener("click", toggleDialog);
  document.body.appendChild(button);

  // Reposition the button on mobile (next to Readmoo's header overflow button)
  // and keep it bottom-right on desktop. The disposer is stored at module level
  // so re-injection / cleanup can tear the watcher down (no leaked listener).
  disposeButtonWatcher?.();
  disposeButtonWatcher = watchMobile((isMobile) => {
    placeFloatingButton(button, isMobile);
  });

  // Best-effort: query pending borrow requests and badge the button.
  // Failures are silent — the badge is a non-essential nicety.
  void updatePendingBorrowBadge(button);
}

/**
 * Fetch pending incoming borrow requests and add a numeric badge to the
 * floating button when count > 0. Silently no-ops on any error so a
 * misconfigured backend never blocks the button from appearing.
 */
async function updatePendingBorrowBadge(button: HTMLElement): Promise<void> {
  try {
    const stored = await browser.storage.local.get([
      USER_ID_KEY,
      FAMILY_ID_KEY,
      AUTH_TOKEN_KEY,
      API_ENDPOINT_KEY,
    ]);
    const userId = stored[USER_ID_KEY] as string | undefined;
    const familyId = stored[FAMILY_ID_KEY] as string | undefined;
    const authToken = stored[AUTH_TOKEN_KEY] as string | undefined;
    const apiEndpoint =
      (stored[API_ENDPOINT_KEY] as string | undefined) ?? DEFAULT_API_ENDPOINT;
    if (!userId || !familyId || !authToken) return;

    const url = `${apiEndpoint.replace(/\/+$/, "")}/api/family/${encodeURIComponent(familyId)}/borrow`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: BorrowRequest[] };
    const requests = json.data ?? [];
    const pending = requests.filter(
      (r) => r.status === BorrowStatus.PENDING && r.ownerId === userId,
    ).length;
    updateBadge(button, pending);
  } catch {
    // ignore — best-effort enhancement
  }
}

/**
 * Single entry point for badge updates: attaches/replaces the badge when
 * count > 0, removes any existing badge when count <= 0. All callers (initial
 * fetch + the dialog's live count callback) go through this so the 0 case is
 * handled consistently.
 */
function updateBadge(button: HTMLElement, count: number): void {
  if (count <= 0) {
    button.querySelector(`#${MOO_ELEMENT_IDS.button}-badge`)?.remove();
    return;
  }
  attachBadge(button, count);
}

function attachBadge(button: HTMLElement, count: number): void {
  // Remove any existing badge before re-attaching
  button.querySelector(`#${MOO_ELEMENT_IDS.button}-badge`)?.remove();

  const badge = document.createElement("span");
  badge.id = `${MOO_ELEMENT_IDS.button}-badge`;
  badge.textContent = String(count);
  badge.style.cssText = [
    "position: absolute",
    "top: -6px",
    "right: -6px",
    "min-width: 18px",
    "height: 18px",
    "padding: 0 5px",
    "border-radius: 9px",
    "background: #dc2626",
    "color: white",
    "font-size: 11px",
    "font-weight: 700",
    "line-height: 18px",
    "text-align: center",
    "box-shadow: 0 1px 3px rgba(0,0,0,0.2)",
    "pointer-events: none",
  ].join(";");
  button.style.position = "fixed"; // ensure parent positioning
  button.appendChild(badge);
}

/**
 * Inject the shell bootstrap stylesheet into the dialog's shadow root.
 * Idempotent: a marked <style> is skipped, mirroring mountDialog's scoped-style
 * injection. Kept separate from the full styles.css so the content-script IIFE
 * never bundles the dialog stylesheet.
 */
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

  // "Already open?" is detected via the light-DOM host: the dialog/backdrop now
  // live inside the host's shadow tree, so document.getElementById cannot see
  // them directly.
  const existingHost = document.getElementById(MOO_ELEMENT_IDS.host);
  if (existingHost) {
    // Toggle off: unmount the React root + dispose ONLY the dialog's breakpoint
    // watcher, then remove the host. The floating button's watcher must survive
    // so the button keeps repositioning on later breakpoint changes.
    disposeDialogShell();
    return;
  }

  // Opening a fresh dialog: defensively clear any stale React root handle so we
  // never orphan a root across open/close cycles (e.g. if a prior close raced).
  unmountDialogRoot();

  const dialog = document.createElement("div");
  dialog.id = MOO_ELEMENT_IDS.dialog;
  // Static structural styles live in SHELL_BOOTSTRAP_CSS (class `.moo-shell-dialog`),
  // injected into the shadow root before this element is appended so it never
  // flashes unstyled ahead of the full styles.css (loaded later by mountDialog).
  // The id is retained for getElementById / E2E selectors. Per-breakpoint
  // position/size/border-radius/height stay JS-driven via applyDialogLayout.
  dialog.className = "moo-shell-dialog";

  // Backdrop — static full-viewport overlay via `.moo-shell-backdrop`; its
  // mobile/desktop `display` toggle stays inline via applyBackdropLayout.
  const backdrop = document.createElement("div");
  backdrop.id = MOO_ELEMENT_IDS.backdrop;
  backdrop.className = "moo-shell-backdrop";

  // Light-DOM host owning the Shadow Root. A plain div creates no stacking
  // context or transform, so the fixed-positioned backdrop/dialog inside still
  // cover the viewport relative to it. The host is what the toggle-off /
  // context-invalidation paths remove.
  const host = document.createElement("div");
  host.id = MOO_ELEMENT_IDS.host;
  const shadowRoot = host.attachShadow({ mode: "open" });

  // Inject the tiny bootstrap stylesheet IMMEDIATELY — before the backdrop/dialog
  // are appended — so the shell's `moo-shell-*` classes resolve the instant those
  // elements render (no flash of unstyled content). The full scoped styles.css is
  // injected into this same root later by mountDialog. The marker attribute gives
  // idempotency parity with that main injection.
  injectShellStyles(shadowRoot);

  // Single close path reused by backdrop click and the mobile close icon.
  // Unmounts the React root, disposes only the dialog's breakpoint watcher
  // (module-level, so the toggle-off branch shares it; the button watcher is
  // separate), then removes the host (backdrop + dialog live in its shadow tree).
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

  // Attach backdrop + dialog INTO the shadow root (isolated from Readmoo CSS),
  // then attach the host to the page. The scoped stylesheet is injected into
  // this same shadow root by mountDialog (via container.getRootNode()).
  shadowRoot.appendChild(backdrop);
  shadowRoot.appendChild(dialog);
  document.body.appendChild(host);

  // Track the latest breakpoint + view so a change to either re-applies the full
  // layout. View starts non-main (loading); React reports changes via onViewChange.
  // Only the desktop main view uses a fixed 80vh height (see applyDialogLayout).
  let currentIsMobile = false;
  let currentIsMainView = false;

  const relayout = (): void => {
    applyDialogLayout(dialog, currentIsMobile, currentIsMainView);
    applyBackdropLayout(backdrop, currentIsMobile);
    closeIcon.style.display = currentIsMobile ? "inline-flex" : "none";
  };

  // Drive full-screen (mobile) vs centred-card (desktop) layout. The disposer
  // is invoked by closeDialog / the toggle-off branch so the listener is
  // cleaned up on every close. Dispose any stale one first (defensive).
  disposeDialogWatcher?.();
  disposeDialogWatcher = watchMobile((isMobile) => {
    currentIsMobile = isMobile;
    relayout();
  });

  // Content scripts run in Chrome's isolated world — standard ES module
  // imports don't resolve correctly, so we load code-split modules via
  // chrome.runtime.getURL() which points to web-accessible extension resources.
  import(/* @vite-ignore */ browser.runtime.getURL("content-dialog.js"))
    .then((mod: DialogModule) => {
      // Race guard: the user may have closed the dialog before this dynamic
      // import resolved. If the mount point is no longer in the DOM, mounting
      // would leak a root nobody holds — so skip entirely.
      if (!mountPoint.isConnected) return;
      // Retain the unmount handle so the close/teardown paths can release the root.
      unmountDialogApp = mod.mountDialog(mountPoint, {
        onViewChange: (view) => {
          currentIsMainView = view === "main";
          relayout();
        },
        // Keep the floating button badge in sync with live borrow-request
        // changes while the dialog is open. The button element still exists in
        // the light DOM while the dialog host is mounted, so look it up by id.
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

/**
 * Opportunistically scrape user email when on the #/me page
 * and cache it in chrome.storage.local for later use.
 */
function tryScrapeAndCacheEmail(): void {
  if (!isExtensionContextValid()) return;
  if (!location.hash.includes("/me")) return;

  // Delay slightly to let React render the profile panel
  setTimeout(() => {
    const email = scrapeUserEmail();
    if (!email) return;

    const displayName = scrapeDisplayName() ?? "";
    void browser.storage.local.set({ [USER_EMAIL_KEY]: email, [DISPLAY_NAME_KEY]: displayName });
  }, 1000);
}

let currentAbortController: AbortController | null = null;

/**
 * Abort any in-flight page-ready wait, then wait for the page to finish
 * loading before injecting the 家庭書櫃 button.
 */
function waitAndInjectButton(): void {
  currentAbortController?.abort();
  const controller = new AbortController();
  currentAbortController = controller;

  // Remove existing button for hashchange re-injection. Dispose its breakpoint
  // watcher first so the stale listener does not outlive the removed button.
  disposeButtonWatcher?.();
  disposeButtonWatcher = null;
  document.getElementById(MOO_ELEMENT_IDS.button)?.remove();

  waitForPageReady(controller.signal)
    .then(() => void injectFamilyBookshelfButton())
    .catch((err: unknown) => {
      // AbortError means a new navigation cancelled this wait — silently ignore
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[MooFamily] Page ready detection failed:", err);
    });
}

/**
 * Listen for floatingIconSize changes and update the existing button in
 * place — avoids re-injection (which would lose the badge state).
 */
function listenForIconSizeChanges(): void {
  if (!isExtensionContextValid()) return;
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[FLOATING_ICON_SIZE_KEY]) return;
    const newValue = changes[FLOATING_ICON_SIZE_KEY].newValue;
    const size: FloatingIconSize = isFloatingIconSize(newValue) ? newValue : "medium";
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
    waitAndInjectButton();
    tryScrapeAndCacheEmail();
  });
}
