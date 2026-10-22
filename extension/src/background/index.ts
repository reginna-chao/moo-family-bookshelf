/** Cross-browser background script: message dispatch between the content script and extension
 *  internals. Storage and messaging rules: docs/architecture.md → 背景 Service Worker 與訊息. */

import browser from "webextension-polyfill";
import {
  messageHandlers,
  type BackgroundMessage,
  type MessageHandler,
} from "./messageHandlers";

browser.runtime.onInstalled.addListener(() => {
  console.log("MooFamily Bookshelf installed");

  // No scheduled background sync (alarms removed, permission dropped): a leftover alarm on an
  // upgraded device is inert. See docs/architecture.md → 背景 Service Worker 與訊息.
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
