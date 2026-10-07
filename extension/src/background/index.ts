/** Cross-browser background script: message dispatch between the content script and extension
 *  internals. Storage and messaging rules: docs/architecture.md → 背景 Service Worker 與訊息. */

import browser from "webextension-polyfill";
import { migrateStorageKeys } from "../storage/migrate";
import {
  messageHandlers,
  type BackgroundMessage,
  type MessageHandler,
} from "./messageHandlers";

// Attempt the storage-key migration on every service-worker activation.
// Guarded by the STORAGE_MIGRATED_KEY flag, so it is a cheap no-op once done.
void migrateStorageKeys();

browser.runtime.onInstalled.addListener(async () => {
  console.log("MooFamily Bookshelf installed");

  // Migrate any legacy (unprefixed) storage keys to the `moo:` namespace.
  // Awaited so the service worker stays alive until migration completes.
  await migrateStorageKeys();

  // No scheduled background sync (alarms removed, permission dropped): a leftover alarm on an
  // upgraded device is inert. See docs/architecture.md → 背景 Service Worker 與訊息.
});

// Re-attempt on browser startup in case the onInstalled migration failed (no-op once done).
browser.runtime.onStartup.addListener(() => {
  void migrateStorageKeys();
});

/** Messages from the content script / dialog: a known type returns a Promise of the response (the
 *  polyfill's async reply, no `sendResponse`); an unknown type returns `undefined`. */
browser.runtime.onMessage.addListener(
  (message: unknown): Promise<unknown> | undefined => {
    const msg = message as BackgroundMessage;
    // One localized cast to the union-accepting MessageHandler: the key already picked the
    // variant's handler, so runtime dispatch is correct.
    const handler = messageHandlers[msg.type] as MessageHandler | undefined;
    if (!handler) return undefined;
    return Promise.resolve(handler(msg));
  },
);
