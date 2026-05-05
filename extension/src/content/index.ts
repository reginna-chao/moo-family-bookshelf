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
import { scrapeUserEmail, scrapeDisplayName } from "./scraper";
import { isExtensionContextValid, cleanupMooFamilyUI, MOO_ELEMENT_IDS } from "../utils/extensionContext";
import { waitForPageReady } from "./pageReady";
import { getAppEnv } from "../utils/appEnv";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { BorrowStatus, type BorrowRequest } from "../api/types";

const APP_ENV = getAppEnv();

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

function injectFamilyBookshelfButton(): void {
  if (!isExtensionContextValid()) {
    cleanupMooFamilyUI();
    return;
  }

  // Avoid duplicate injection
  if (document.getElementById(MOO_ELEMENT_IDS.button)) return;

  const button = document.createElement("button");
  button.id = MOO_ELEMENT_IDS.button;
  button.textContent = "家庭書櫃";
  button.style.cssText = [
    "position: fixed",
    "bottom: 24px",
    "right: 24px",
    "z-index: 99999",
    "padding: 12px 20px",
    "border-radius: 8px",
    "border: none",
    "background: #2563eb",
    "color: white",
    "font-size: 14px",
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
    const stored = await chrome.storage.local.get([
      "userId",
      "familyId",
      "authToken",
      "apiEndpoint",
    ]);
    const userId = stored.userId as string | undefined;
    const familyId = stored.familyId as string | undefined;
    const authToken = stored.authToken as string | undefined;
    const apiEndpoint =
      (stored.apiEndpoint as string | undefined) ?? DEFAULT_API_ENDPOINT;
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
  import(/* @vite-ignore */ chrome.runtime.getURL("content-dialog.js"))
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
    chrome.storage.local.set({ userEmail: email, displayName });
  }, 1000);
}

/**
 * Handle background sync requests from the service worker.
 * The background alarm handler sends TRIGGER_BOOK_SYNC when
 * it finds an open read.readmoo.com tab.
 */
function listenForBackgroundSync(): void {
  if (!isExtensionContextValid()) return;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "TRIGGER_BOOK_SYNC") {
      if (!isExtensionContextValid()) {
        sendResponse({ success: false, error: "Extension context invalidated" });
        return;
      }
      // ApiClient is re-exported from content-sync.js, so a single import suffices.
      import(/* @vite-ignore */ chrome.runtime.getURL("content-sync.js"))
        .then(async ({ syncBooks, ApiClient }) => {
          const storageResult = await chrome.storage.local.get(["userId", "authToken", "apiEndpoint"]);
          const userId = storageResult.userId as string | undefined;
          if (!userId) {
            sendResponse({ success: false, error: "No userId" });
            return;
          }

          const apiClient = new ApiClient(storageResult.apiEndpoint as string | undefined);
          if (storageResult.authToken) {
            apiClient.setAuthToken(storageResult.authToken as string);
          }

          const result = await syncBooks({ navigate: true, userId, apiClient });
          if (result.success) {
            chrome.runtime.sendMessage({ type: "CLEAR_SYNC_ERROR_BADGE" });
          }
          sendResponse({
            success: result.success,
            error: result.error,
          });
        })
        .catch((err) => {
          console.error("[MooFamily] Failed to load sync module:", err);
          sendResponse({ success: false, error: "Module load failed" });
        });
      return true; // async response
    }
  });
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
    .then(() => injectFamilyBookshelfButton())
    .catch((err: unknown) => {
      // AbortError means a new navigation cancelled this wait — silently ignore
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[MooFamily] Page ready detection failed:", err);
    });
}

// Run on page load
if (!isExtensionContextValid()) {
  cleanupMooFamilyUI();
} else {
  const init = (): void => {
    waitAndInjectButton();
    tryScrapeAndCacheEmail();
    listenForBackgroundSync();
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
