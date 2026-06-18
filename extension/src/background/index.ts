/**
 * Cross-browser Extension Service Worker (background script).
 * Handles messaging between content script and extension internals.
 *
 * Storage strategy:
 * - familyId: written to BOTH browser.storage.sync and browser.storage.local.
 *   Read from sync first, falling back to local. This enables multi-device sync
 *   for users signed into the same browser account.
 * - apiEndpoint: local only (different devices may use different endpoints).
 *
 * Messaging strategy (webextension-polyfill):
 * - The onMessage listener returns a Promise that resolves to the response
 *   object. There is no `sendResponse` + `return true` — under the polyfill,
 *   returning a Promise IS the async response mechanism.
 */

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

  // Background scheduled sync (alarms) was removed; sync now only runs
  // when the user opens their personal shelf. The `alarms` permission was
  // dropped, so any leftover alarm on an upgrading device simply becomes an
  // inert no-op (no listener consumes it).
});

// Resilience: re-attempt the storage migration on browser startup in case a
// previous onInstalled migration failed (the flag guard makes this a no-op
// once migration has completed).
browser.runtime.onStartup.addListener(() => {
  void migrateStorageKeys();
});

/**
 * Listen for messages from content script / dialog.
 *
 * Returns a Promise (resolving to the response object) for known message
 * types — the polyfill forwards that to the sender's awaited
 * `browser.runtime.sendMessage`. Unknown types return `undefined`.
 */
browser.runtime.onMessage.addListener((message: unknown): Promise<unknown> | undefined => {
  const msg = message as BackgroundMessage;
  // messageHandlers[msg.type] is the specific variant handler for msg.type;
  // a single localized cast to the union-accepting MessageHandler lets us
  // invoke it with the full message (runtime dispatch is correct by key).
  const handler = messageHandlers[msg.type] as MessageHandler | undefined;
  if (!handler) return undefined;
  return Promise.resolve(handler(msg));
});
