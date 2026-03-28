/**
 * Content Script — injected into Readmoo pages.
 * Responsibilities:
 * 1. Inject the "家庭書櫃" button into the page
 * 2. Mount the Dialog UI when button is clicked
 */

function injectFamilyBookshelfButton(): void {
  // Avoid duplicate injection
  if (document.getElementById("moo-family-bookshelf-btn")) return;

  const button = document.createElement("button");
  button.id = "moo-family-bookshelf-btn";
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
  const existing = document.getElementById("moo-family-bookshelf-dialog");
  if (existing) {
    existing.remove();
    return;
  }

  const dialog = document.createElement("div");
  dialog.id = "moo-family-bookshelf-dialog";
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
  ].join(";");

  // Backdrop
  const backdrop = document.createElement("div");
  backdrop.id = "moo-family-bookshelf-backdrop";
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
  mountPoint.id = "moo-family-bookshelf-root";
  dialog.appendChild(mountPoint);

  document.body.appendChild(backdrop);
  document.body.appendChild(dialog);

  // Dynamically import and mount the React Dialog into the container
  import("../dialog/main").then(({ mountDialog }) => {
    mountDialog(mountPoint);
  });
}

/**
 * Opportunistically scrape user email when on the #/me page
 * and cache it in chrome.storage.local for later use.
 */
function tryScrapeAndCacheEmail(): void {
  if (!location.hash.includes("/me")) return;

  // Delay slightly to let React render the profile panel
  setTimeout(async () => {
    const { scrapeUserEmail, scrapeDisplayName } = await import("./scraper");
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
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "TRIGGER_BOOK_SYNC") {
      import("../sync/syncBooks").then(async ({ syncBooks }) => {
        const storageResult = await chrome.storage.local.get(["userId", "authToken", "apiEndpoint"]);
        const userId = storageResult.userId as string | undefined;
        if (!userId) {
          sendResponse({ success: false, error: "No userId" });
          return;
        }

        const { ApiClient } = await import("../api/client");
        const apiClient = new ApiClient(storageResult.apiEndpoint as string | undefined);
        if (storageResult.authToken) {
          apiClient.setAuthToken(storageResult.authToken as string);
        }

        const result = await syncBooks({ navigate: true, userId, apiClient });
        sendResponse({ success: result.success, error: result.error });
      });
      return true; // async response
    }
  });
}

// Run on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    injectFamilyBookshelfButton();
    tryScrapeAndCacheEmail();
    listenForBackgroundSync();
  });
} else {
  injectFamilyBookshelfButton();
  tryScrapeAndCacheEmail();
  listenForBackgroundSync();
}

// Also listen for hash changes (SPA navigation)
window.addEventListener("hashchange", tryScrapeAndCacheEmail);
