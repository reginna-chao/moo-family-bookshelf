/**
 * Sync error badge helper for the extension toolbar icon.
 * Guards against `chrome.action` being undefined (when the manifest
 * does not declare `"action"`) so callers never crash the service worker.
 */

import browser from "webextension-polyfill";

export function showSyncErrorBadge(): void {
  if (!browser.action?.setBadgeText) return;
  void browser.action.setBadgeText({ text: "!" });
  void browser.action.setBadgeBackgroundColor?.({ color: "#EF4444" });
}

export function clearSyncErrorBadge(): void {
  if (!browser.action?.setBadgeText) return;
  void browser.action.setBadgeText({ text: "" });
}
