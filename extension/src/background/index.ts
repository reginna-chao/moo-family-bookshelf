/**
 * Chrome Extension Service Worker (background script).
 * Handles messaging between content script and extension internals.
 *
 * Storage strategy:
 * - familyId: written to BOTH chrome.storage.sync and chrome.storage.local.
 *   Read from sync first, falling back to local. This enables multi-device sync
 *   for users signed into the same Google account.
 * - encryptionKey: local ONLY. Never synced to Google Cloud to prevent key
 *   exposure if the Google account is compromised. Cross-device setup uses
 *   the sync code mechanism instead.
 * - apiEndpoint: local only (different devices may use different endpoints).
 */

/** Keys that are synced across devices via chrome.storage.sync */
const SYNCED_KEYS = ["familyId"] as const;

/** Alarm name for scheduled background book sync */
const BOOK_SYNC_ALARM_NAME = "bookSync";

/** Background sync interval in minutes (24 hours) */
const BACKGROUND_SYNC_INTERVAL_MIN = 24 * 60;

chrome.runtime.onInstalled.addListener(async () => {
  console.log("MooFamily Bookshelf installed");

  // Create recurring alarm for background book sync (skip if already exists)
  const existing = await chrome.alarms.get(BOOK_SYNC_ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(BOOK_SYNC_ALARM_NAME, {
      periodInMinutes: BACKGROUND_SYNC_INTERVAL_MIN,
    });
  }
});

/**
 * Handle the background sync alarm.
 * Finds an open read.readmoo.com tab and sends a sync message.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BOOK_SYNC_ALARM_NAME) return;

  try {
    const tabs = await chrome.tabs.query({ url: "https://read.readmoo.com/*" });
    if (tabs.length === 0 || !tabs[0].id) {
      console.log("[bookSync] No read.readmoo.com tab found, skipping sync");
      return;
    }

    chrome.tabs.sendMessage(tabs[0].id, { type: "TRIGGER_BOOK_SYNC" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[bookSync] Failed to message tab:", chrome.runtime.lastError.message);
        return;
      }
      if (response?.success) {
        console.log("[bookSync] Background sync completed successfully");
      } else {
        console.warn("[bookSync] Background sync failed:", response?.error);
      }
    });
  } catch (err) {
    console.warn("[bookSync] Alarm handler error:", err);
  }
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
      chrome.storage.local.remove([...SYNCED_KEYS, "encryptionKey", "authToken"], () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "GET_SYNC_ARCHIVED") {
    chrome.storage.local.get(["syncArchived"], (result) => {
      sendResponse({ syncArchived: result.syncArchived ?? 0 });
    });
    return true;
  }

  if (message.type === "SET_SYNC_ARCHIVED") {
    const value = message.syncArchived;
    if (value !== 0 && value !== 1) {
      sendResponse({ ok: false, error: "syncArchived must be 0 or 1" });
      return true;
    }
    chrome.storage.local.set({ syncArchived: value }, () => {
      sendResponse({ ok: true });
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
    const endpoint = message.apiEndpoint;
    if (endpoint === null || endpoint === undefined) {
      // Clear: remove custom endpoint, revert to default
      chrome.storage.local.remove("apiEndpoint", () => {
        sendResponse({ ok: 1 });
      });
    } else if (typeof endpoint === "string") {
      // Validate URL before storing
      try {
        const parsed = new URL(endpoint);
        const isHttps = parsed.protocol === "https:";
        const isLocalHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
        if (!isHttps && !isLocalHttp) {
          sendResponse({ ok: 0, error: "Invalid protocol" });
          return true;
        }
      } catch {
        sendResponse({ ok: 0, error: "Invalid URL" });
        return true;
      }
      chrome.storage.local.set({ apiEndpoint: endpoint }, () => {
        sendResponse({ ok: 1 });
      });
    } else {
      sendResponse({ ok: 0, error: "Invalid endpoint value" });
    }
    return true;
  }
});
