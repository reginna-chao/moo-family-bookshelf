/** Background message handlers: one per type, only that message's work,
 *  RETURNING the response (polyfill convention); dispatch wiring lives in index.ts. */

import browser from "webextension-polyfill";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "../constants";

/** Keys that are synced across devices via browser.storage.sync */
const SYNCED_KEYS = [FAMILY_ID_KEY] as const;

/**
 * Discriminated union of all incoming background messages, keyed by `type`.
 *
 * Payload fields are typed as their BROAD input type (a plain string), NOT a
 * validated literal union: these values are untrusted input, and a narrower
 * type here would claim a check nothing has made.
 */
export type BackgroundMessage =
  | { type: "SET_FAMILY_ID"; familyId: string }
  | { type: "CLEAR_FAMILY_ID" }
  | { type: "OPEN_OPTIONS_PAGE" };

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

async function handleSetFamilyId(
  message: Extract<BackgroundMessage, { type: "SET_FAMILY_ID" }>,
): Promise<unknown> {
  // Local first (source of truth); the storage.sync write is best-effort and isolated, since it can
  // reject in Firefox. See docs/architecture.md → 本機儲存與同步.
  await browser.storage.local.set({ [FAMILY_ID_KEY]: message.familyId });
  try {
    await browser.storage.sync.set({ [FAMILY_ID_KEY]: message.familyId });
  } catch {
    console.warn(
      "[Background] storage.sync.set failed for familyId; local write kept",
    );
  }
  return { ok: true };
}

async function handleClearFamilyId(): Promise<unknown> {
  // Local first, so unbind always clears familyId + auth credentials even if storage.sync rejects;
  // the sync removal is best-effort and cannot abort the local clear.
  await browser.storage.local.remove([
    ...SYNCED_KEYS,
    AUTH_TOKEN_KEY,
    TOKEN_EXPIRES_AT_KEY,
  ]);
  try {
    await browser.storage.sync.remove(SYNCED_KEYS as unknown as string[]);
  } catch {
    console.warn(
      "[Background] storage.sync.remove failed for familyId; local clear kept",
    );
  }
  return { ok: true };
}

/** The Dialog asks for the options page when the store-page chip still needs its host permission. */
async function handleOpenOptionsPage(): Promise<unknown> {
  await browser.runtime.openOptionsPage();
  return { ok: 1 };
}

/** Dispatch map: message type → handler. */
export const messageHandlers: MessageHandlerMap = {
  SET_FAMILY_ID: handleSetFamilyId,
  CLEAR_FAMILY_ID: handleClearFamilyId,
  OPEN_OPTIONS_PAGE: handleOpenOptionsPage,
};
