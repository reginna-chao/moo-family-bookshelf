/** Background message handlers: one per type, only that message's work,
 *  RETURNING the response (polyfill convention); dispatch wiring lives in index.ts. */

import browser from "webextension-polyfill";

/**
 * Discriminated union of all incoming background messages, keyed by `type`.
 *
 * Payload fields are typed as their BROAD input type (a plain string), NOT a
 * validated literal union: these values are untrusted input, and a narrower
 * type here would claim a check nothing has made.
 */
export type BackgroundMessage = { type: "OPEN_OPTIONS_PAGE" };

/** Message type discriminant union (the `type` field of every message). */
export type BackgroundMessageType = BackgroundMessage["type"];

/**
 * Per-type handler map: each handler receives its SPECIFIC message variant.
 * Keying by `M["type"]` gives every handler exactly the payload fields its
 * variant carries, so variant-specific field access type-checks cleanly.
 */
export type MessageHandlerMap = {
  [M in BackgroundMessage as M["type"]]: (
    message: M,
  ) => Promise<unknown> | unknown;
};

/** A handler accepts any background message and returns a response. */
export type MessageHandler = (
  message: BackgroundMessage,
) => Promise<unknown> | unknown;

/** The Dialog asks for the options page when the store-page chip still needs its host permission. */
async function handleOpenOptionsPage(): Promise<unknown> {
  await browser.runtime.openOptionsPage();
  return { ok: 1 };
}

/** Dispatch map: message type → handler. */
export const messageHandlers: MessageHandlerMap = {
  OPEN_OPTIONS_PAGE: handleOpenOptionsPage,
};
