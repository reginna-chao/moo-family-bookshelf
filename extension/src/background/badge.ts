/**
 * Sync error badge helper for the extension toolbar icon.
 * Guards against `chrome.action` being undefined (when the manifest
 * does not declare `"action"`) so callers never crash the service worker.
 */

export function showSyncErrorBadge(): void {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor?.({ color: "#EF4444" });
}

export function clearSyncErrorBadge(): void {
  if (!chrome.action?.setBadgeText) return;
  chrome.action.setBadgeText({ text: "" });
}
