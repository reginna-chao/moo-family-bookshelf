/** Cross-browser background script: message dispatch between the content script and extension
 *  internals. Storage and messaging rules: docs/architecture.md → 背景 Service Worker 與訊息. */

import browser from "webextension-polyfill";
import {
  messageHandlers,
  type BackgroundMessage,
  type BackgroundMessageType,
  type MessageHandler,
} from "./messageHandlers";
import { purgeStoredEmail } from "./purgeStoredEmail";
import { reconcileStorePageScript } from "./storePageScript";
import {
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_INDEX_KEY,
} from "../constants";

browser.runtime.onInstalled.addListener(() => {
  console.log("MooFamily Bookshelf installed");
  // Fires on install AND every update: drops the email older versions stored (#359).
  void purgeStoredEmail();
  void reconcileStorePageScript();

  // No scheduled background sync (alarms removed, permission dropped): a leftover alarm on an
  // upgraded device is inert. See docs/architecture.md → 背景 Service Worker 與訊息.
});

// Store-page chip (#313): re-align on browser start, on every permission or switch change, and on
// every index write, so an index written while the switch is off is cleared by the serialised reconcile.
browser.runtime.onStartup.addListener(() => void reconcileStorePageScript());
browser.permissions.onAdded.addListener(() => void reconcileStorePageScript());
browser.permissions.onRemoved.addListener(
  () => void reconcileStorePageScript(),
);

/** The switch changed, or the index was written (a removal needs no clearing and is our own clear). */
function touchesStorePageChip(
  changes: Record<string, browser.Storage.StorageChange>,
): boolean {
  if (Object.hasOwn(changes, STORE_PAGE_CHIP_ENABLED_KEY)) return true;
  if (!Object.hasOwn(changes, STORE_PAGE_INDEX_KEY)) return false;
  return changes[STORE_PAGE_INDEX_KEY].newValue !== undefined;
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!touchesStorePageChip(changes)) return;
  void reconcileStorePageScript();
});

// No popup: the toolbar icon opens the options page (the store-page chip switch).
browser.action.onClicked.addListener(() => {
  void browser.runtime.openOptionsPage();
});

/** Dispatches only an object whose string `type` is an own key of `messageHandlers` (a Promise of the
 *  response, no `sendResponse`); anything else returns `undefined`. */
browser.runtime.onMessage.addListener(
  (message: unknown): Promise<unknown> | undefined => {
    if (typeof message !== "object" || message === null) return undefined;
    const type = (message as { type?: unknown }).type;
    // Own keys only: a prototype name ("toString", "__proto__") must never reach a handler.
    if (typeof type !== "string" || !Object.hasOwn(messageHandlers, type))
      return undefined;
    // One localized cast to the union-accepting MessageHandler: the key already picked the
    // variant's handler, so runtime dispatch is correct.
    const handler = messageHandlers[
      type as BackgroundMessageType
    ] as MessageHandler;
    return Promise.resolve(handler(message as BackgroundMessage));
  },
);
