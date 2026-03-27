/**
 * Chrome Extension Service Worker (background script).
 * Handles messaging between content script and extension internals.
 *
 * Storage strategy:
 * - familyId + encryptionKey: written to BOTH chrome.storage.sync and chrome.storage.local.
 *   Read from sync first, falling back to local. This enables multi-device sync
 *   for users signed into the same Google account.
 * - apiEndpoint: local only (different devices may use different endpoints).
 */

/** Keys that are synced across devices via chrome.storage.sync */
const SYNCED_KEYS = ["familyId", "encryptionKey"] as const;

chrome.runtime.onInstalled.addListener(() => {
  console.log("MooFamily Bookshelf installed");
});

/**
 * Read a value from chrome.storage.sync first, falling back to chrome.storage.local.
 */
function getWithSyncFallback(
  key: string,
  callback: (value: unknown) => void,
): void {
  chrome.storage.sync.get([key], (syncResult) => {
    if (syncResult[key] !== undefined) {
      callback(syncResult[key]);
      return;
    }
    chrome.storage.local.get([key], (localResult) => {
      callback(localResult[key] ?? null);
    });
  });
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_FAMILY_ID") {
    getWithSyncFallback("familyId", (value) => {
      sendResponse({ familyId: value ?? null });
    });
    return true; // async response
  }

  if (message.type === "SET_FAMILY_ID") {
    chrome.storage.sync.set({ familyId: message.familyId }, () => {
      chrome.storage.local.set({ familyId: message.familyId }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "CLEAR_FAMILY_ID") {
    chrome.storage.sync.remove(SYNCED_KEYS as unknown as string[], () => {
      chrome.storage.local.remove([...SYNCED_KEYS], () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "GET_API_ENDPOINT") {
    chrome.storage.local.get(["apiEndpoint"], (result) => {
      sendResponse({ apiEndpoint: result.apiEndpoint ?? null });
    });
    return true;
  }

  if (message.type === "SET_API_ENDPOINT") {
    chrome.storage.local.set({ apiEndpoint: message.apiEndpoint }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
