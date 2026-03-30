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

  button.addEventListener("click", toggleDialog);
  document.body.appendChild(button);
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
  dialog.appendChild(mountPoint);

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  // Content scripts run in Chrome's isolated world — standard ES module
  // imports don't resolve correctly, so we load code-split modules via
  // chrome.runtime.getURL() which points to web-accessible extension resources.
  let dialogUrl: string;
  try {
    dialogUrl = chrome.runtime.getURL("content-dialog.js");
  } catch {
    cleanupMooFamilyUI();
    return;
  }
  console.log("[MooFamily] Loading dialog from:", dialogUrl);
  import(/* @vite-ignore */ dialogUrl)
    .then(({ mountDialog }) => {
      console.log("[MooFamily] Dialog module loaded, mounting...");
      mountDialog(mountPoint);
    })
    .catch((err) => {
      console.error("[MooFamily] Failed to load dialog module from:", dialogUrl, err);
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
          sendResponse({ success: result.success, error: result.error });
        })
        .catch((err) => {
          console.error("[MooFamily] Failed to load sync module:", err);
          sendResponse({ success: false, error: "Module load failed" });
        });
      return true; // async response
    }
  });
}

// Run on page load
if (!isExtensionContextValid()) {
  cleanupMooFamilyUI();
} else if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    injectFamilyBookshelfButton();
    tryScrapeAndCacheEmail();
    listenForBackgroundSync();
  });
  // Also listen for hash changes (SPA navigation)
  window.addEventListener("hashchange", tryScrapeAndCacheEmail);
} else {
  injectFamilyBookshelfButton();
  tryScrapeAndCacheEmail();
  listenForBackgroundSync();
  // Also listen for hash changes (SPA navigation)
  window.addEventListener("hashchange", tryScrapeAndCacheEmail);
}
