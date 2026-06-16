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
    cleanupMooFamilyUI();
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
    if (pending > 0) {
      attachBadge(button, pending);
    }
  } catch {
    // ignore — best-effort enhancement
  }
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

function toggleDialog(): void {
  if (!isExtensionContextValid()) {
    cleanupMooFamilyUI();
    return;
  }

  const existing = document.getElementById(MOO_ELEMENT_IDS.dialog);
  if (existing) {
    existing.remove();
    return;
  }

  const dialog = document.createElement("div");
  dialog.id = MOO_ELEMENT_IDS.dialog;
  dialog.style.cssText = [
    "position: fixed",
    "top: 50%",
    "left: 50%",
    "transform: translate(-50%, -50%)",
    "z-index: 100000",
    "width: 90vw",
    "max-width: 640px",
    "max-height: 80vh",
    "background: white",
    "border-radius: 12px",
    "box-shadow: 0 8px 32px rgba(0,0,0,0.2)",
    "overflow: hidden",
    "display: flex",
    "flex-direction: column",
    "min-height: 200px",
  ].join(";");

  // Backdrop
  const backdrop = document.createElement("div");
  backdrop.id = MOO_ELEMENT_IDS.backdrop;
  backdrop.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 100vw",
    "height: 100vh",
    "z-index: 99999",
    "background: rgba(0,0,0,0.4)",
  ].join(";");
  backdrop.addEventListener("click", () => {
    dialog.remove();
    backdrop.remove();
  });

  // Mount point for React app
  const mountPoint = document.createElement("div");
  mountPoint.id = MOO_ELEMENT_IDS.root;
  mountPoint.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0";
  dialog.appendChild(mountPoint);

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  // Content scripts run in Chrome's isolated world — standard ES module
  // imports don't resolve correctly, so we load code-split modules via
  // chrome.runtime.getURL() which points to web-accessible extension resources.
  import(/* @vite-ignore */ browser.runtime.getURL("content-dialog.js"))
    .then(({ mountDialog }) => {
      mountDialog(mountPoint);
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

  // Remove existing button for hashchange re-injection
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
  cleanupMooFamilyUI();
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
