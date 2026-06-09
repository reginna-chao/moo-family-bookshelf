/**
 * Chrome Extension Service Worker (background script).
 * Handles messaging between content script and extension internals.
 *
 * Storage strategy:
 * - familyId: written to BOTH chrome.storage.sync and chrome.storage.local.
 *   Read from sync first, falling back to local. This enables multi-device sync
 *   for users signed into the same Google account.
 * - apiEndpoint: local only (different devices may use different endpoints).
 */

import { BoolFlag } from "../api/client";
import { showSyncErrorBadge, clearSyncErrorBadge } from "./badge";
import { migrateStorageKeys } from "../storage/migrate";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  SYNC_ARCHIVED_KEY,
  FAMILY_SHELF_VIEW_MODE_KEY,
  FLOATING_ICON_SIZE_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  FAMILY_SHELF_SORT_KEY,
  PERSONAL_SHELF_SORT_KEY,
  API_ENDPOINT_KEY,
} from "../constants";

/** Keys that are synced across devices via chrome.storage.sync */
const SYNCED_KEYS = [FAMILY_ID_KEY] as const;

// Attempt the storage-key migration on every service-worker activation.
// Guarded by the STORAGE_MIGRATED_KEY flag, so it is a cheap no-op once done.
void migrateStorageKeys();

chrome.runtime.onInstalled.addListener(async () => {
  console.log("MooFamily Bookshelf installed");

  // Migrate any legacy (unprefixed) storage keys to the `moo:` namespace.
  // Awaited so the service worker stays alive until migration completes.
  await migrateStorageKeys();

  // Background scheduled sync (chrome.alarms) was removed; sync now only runs
  // when the user opens their personal shelf. The `alarms` permission was
  // dropped, so any leftover alarm on an upgrading device simply becomes an
  // inert no-op (no listener consumes it).
});

// Resilience: re-attempt the storage migration on browser startup in case a
// previous onInstalled migration failed (the flag guard makes this a no-op
// once migration has completed).
chrome.runtime.onStartup.addListener(() => {
  void migrateStorageKeys();
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
    getWithSyncFallback(FAMILY_ID_KEY, (value) => {
      sendResponse({ familyId: value ?? null });
    });
    return true; // async response
  }

  if (message.type === "SET_FAMILY_ID") {
    chrome.storage.sync.set({ [FAMILY_ID_KEY]: message.familyId }, () => {
      chrome.storage.local.set({ [FAMILY_ID_KEY]: message.familyId }, () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "CLEAR_FAMILY_ID") {
    chrome.storage.sync.remove(SYNCED_KEYS as unknown as string[], () => {
      chrome.storage.local.remove([...SYNCED_KEYS, AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY], () => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (message.type === "GET_SYNC_ARCHIVED") {
    chrome.storage.local.get([SYNC_ARCHIVED_KEY], (result) => {
      sendResponse({ syncArchived: result[SYNC_ARCHIVED_KEY] ?? BoolFlag.FALSE });
    });
    return true;
  }

  if (message.type === "SET_SYNC_ARCHIVED") {
    const value = message.syncArchived;
    if (value !== BoolFlag.FALSE && value !== BoolFlag.TRUE) {
      sendResponse({ ok: false, error: "syncArchived must be 0 or 1" });
      return true;
    }
    chrome.storage.local.set({ [SYNC_ARCHIVED_KEY]: value }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_FAMILY_SHELF_VIEW_MODE") {
    chrome.storage.local.get([FAMILY_SHELF_VIEW_MODE_KEY], (result) => {
      const stored = result[FAMILY_SHELF_VIEW_MODE_KEY];
      const viewMode = stored === "row" ? "row" : "grid";
      sendResponse({ viewMode });
    });
    return true;
  }

  if (message.type === "SET_FAMILY_SHELF_VIEW_MODE") {
    const value = message.viewMode;
    if (value !== "grid" && value !== "row") {
      sendResponse({ ok: false, error: "viewMode must be 'grid' or 'row'" });
      return true;
    }
    chrome.storage.local.set({ [FAMILY_SHELF_VIEW_MODE_KEY]: value }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_FLOATING_ICON_SIZE") {
    chrome.storage.local.get([FLOATING_ICON_SIZE_KEY], (result) => {
      const stored = result[FLOATING_ICON_SIZE_KEY];
      const size =
        stored === "small" || stored === "medium" || stored === "large" || stored === "icon"
          ? stored
          : "medium";
      sendResponse({ size });
    });
    return true;
  }

  if (message.type === "SET_FLOATING_ICON_SIZE") {
    const value = message.size;
    if (value !== "small" && value !== "medium" && value !== "large" && value !== "icon") {
      sendResponse({ ok: false, error: "size must be 'small', 'medium', 'large', or 'icon'" });
      return true;
    }
    chrome.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: value }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_AUTO_SYNC_INTERVAL") {
    chrome.storage.local.get([AUTO_SYNC_INTERVAL_KEY], (result) => {
      const stored = result[AUTO_SYNC_INTERVAL_KEY];
      const interval =
        stored === "daily" || stored === "weekly" || stored === "monthly" || stored === "never"
          ? stored
          : "daily";
      sendResponse({ interval });
    });
    return true;
  }

  if (message.type === "SET_AUTO_SYNC_INTERVAL") {
    const value = message.interval;
    if (value !== "daily" && value !== "weekly" && value !== "monthly" && value !== "never") {
      sendResponse({ ok: false, error: "interval must be 'daily', 'weekly', 'monthly', or 'never'" });
      return true;
    }
    chrome.storage.local.set({ [AUTO_SYNC_INTERVAL_KEY]: value }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "GET_BOOK_SORT") {
    const shelf = message.shelf;
    if (shelf !== "family" && shelf !== "personal") {
      sendResponse({ sort: "default" });
      return true;
    }
    const key = shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
    chrome.storage.local.get([key], (result) => {
      const stored = result[key];
      const sort =
        stored === "default" || stored === "title" || stored === "author"
          ? stored
          : "default";
      sendResponse({ sort });
    });
    return true;
  }

  if (message.type === "SET_BOOK_SORT") {
    const shelf = message.shelf;
    const value = message.sort;
    if (shelf !== "family" && shelf !== "personal") {
      sendResponse({ ok: false, error: "shelf must be 'family' or 'personal'" });
      return true;
    }
    if (value !== "default" && value !== "title" && value !== "author") {
      sendResponse({ ok: false, error: "sort must be 'default', 'title', or 'author'" });
      return true;
    }
    const key = shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
    chrome.storage.local.set({ [key]: value }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "SET_SYNC_ERROR_BADGE") {
    showSyncErrorBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CLEAR_SYNC_ERROR_BADGE") {
    clearSyncErrorBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "GET_API_ENDPOINT") {
    chrome.storage.local.get([API_ENDPOINT_KEY], (result) => {
      sendResponse({ apiEndpoint: result[API_ENDPOINT_KEY] ?? null });
    });
    return true;
  }

  if (message.type === "SET_API_ENDPOINT") {
    const endpoint = message.apiEndpoint;
    if (endpoint === null || endpoint === undefined) {
      // Clear: remove custom endpoint, revert to default
      chrome.storage.local.remove(API_ENDPOINT_KEY, () => {
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
      chrome.storage.local.set({ [API_ENDPOINT_KEY]: endpoint }, () => {
        sendResponse({ ok: 1 });
      });
    } else {
      sendResponse({ ok: 0, error: "Invalid endpoint value" });
    }
    return true;
  }
});
