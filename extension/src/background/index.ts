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

browser.runtime.onInstalled.addListener(() => {
  console.log("MooFamily Bookshelf installed");
  // Fires on install AND every update: drops the email older versions stored (#359).
  void purgeStoredEmail();

  // No scheduled background sync (alarms removed, permission dropped): a leftover alarm on an
  // upgraded device is inert. See docs/architecture.md → 背景 Service Worker 與訊息.
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
