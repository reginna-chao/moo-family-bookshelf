/**
 * Per-message handlers for the background service worker.
 *
 * Each handler is an async function that RETURNS the response object (the
 * webextension-polyfill convention for async message responses — the listener
 * returns a Promise that resolves to the response, instead of the Chrome-only
 * `sendResponse` + `return true` pattern).
 *
 * Handlers own a single message type and contain only the storage access +
 * validation for that message; the dispatch wiring lives in index.ts.
 */

import browser from "webextension-polyfill";
import { BoolFlag } from "../api/client";
import { normalizeSortMode } from "../dialog/sortBooks";
import { readFamilyId } from "../storage/familyId";
import { showSyncErrorBadge, clearSyncErrorBadge } from "./badge";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  SYNC_ARCHIVED_KEY,
  FLOATING_ICON_SIZE_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  FAMILY_SHELF_SORT_KEY,
  PERSONAL_SHELF_SORT_KEY,
  API_ENDPOINT_KEY,
} from "../constants";

/** Keys that are synced across devices via browser.storage.sync */
const SYNCED_KEYS = [FAMILY_ID_KEY] as const;

/**
 * Discriminated union of all incoming background messages, keyed by `type`.
 *
 * Payload fields are typed as their BROAD input type (string, number,
 * string | null) — NOT the validated literal unions — because these values
 * are untrusted input that the handlers validate at runtime. Narrowing here
 * would turn those runtime guards into dead code.
 */
export type BackgroundMessage =
  | { type: "GET_FAMILY_ID" }
  | { type: "SET_FAMILY_ID"; familyId: string }
  | { type: "CLEAR_FAMILY_ID" }
  | { type: "GET_SYNC_ARCHIVED" }
  | { type: "SET_SYNC_ARCHIVED"; syncArchived: number }
  | { type: "GET_FLOATING_ICON_SIZE" }
  | { type: "SET_FLOATING_ICON_SIZE"; size: string }
  | { type: "GET_AUTO_SYNC_INTERVAL" }
  | { type: "SET_AUTO_SYNC_INTERVAL"; interval: string }
  | { type: "GET_BOOK_SORT"; shelf: string }
  | { type: "SET_BOOK_SORT"; shelf: string; sort: string }
  | { type: "SET_SYNC_ERROR_BADGE" }
  | { type: "CLEAR_SYNC_ERROR_BADGE" }
  | { type: "GET_API_ENDPOINT" }
  | { type: "SET_API_ENDPOINT"; apiEndpoint: string | null };

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

async function handleGetFamilyId(): Promise<unknown> {
  return { familyId: await readFamilyId() };
}

async function handleSetFamilyId(
  message: Extract<BackgroundMessage, { type: "SET_FAMILY_ID" }>,
): Promise<unknown> {
  // Local is the reliable source of truth — write it first so persistence
  // never depends on storage.sync, which can reject in Firefox (no signed-in
  // account, Android limits, or the pref disabled). The sync write is
  // best-effort and isolated so its failure cannot prevent the local write.
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
  // Local is authoritative — remove it first so unbind always clears the local
  // familyId + auth credentials even if storage.sync rejects in Firefox. The
  // sync removal is best-effort and isolated so it cannot abort the local clear.
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

async function handleGetSyncArchived(): Promise<unknown> {
  const result = await browser.storage.local.get([SYNC_ARCHIVED_KEY]);
  return { syncArchived: result[SYNC_ARCHIVED_KEY] ?? BoolFlag.FALSE };
}

async function handleSetSyncArchived(
  message: Extract<BackgroundMessage, { type: "SET_SYNC_ARCHIVED" }>,
): Promise<unknown> {
  const value = message.syncArchived;
  if (value !== BoolFlag.FALSE && value !== BoolFlag.TRUE) {
    return { ok: false, error: "syncArchived must be 0 or 1" };
  }
  await browser.storage.local.set({ [SYNC_ARCHIVED_KEY]: value });
  return { ok: true };
}

async function handleGetFloatingIconSize(): Promise<unknown> {
  const result = await browser.storage.local.get([FLOATING_ICON_SIZE_KEY]);
  const stored = result[FLOATING_ICON_SIZE_KEY];
  const size =
    stored === "small" ||
    stored === "medium" ||
    stored === "large" ||
    stored === "icon"
      ? stored
      : "medium";
  return { size };
}

async function handleSetFloatingIconSize(
  message: Extract<BackgroundMessage, { type: "SET_FLOATING_ICON_SIZE" }>,
): Promise<unknown> {
  const value = message.size;
  if (
    value !== "small" &&
    value !== "medium" &&
    value !== "large" &&
    value !== "icon"
  ) {
    return {
      ok: false,
      error: "size must be 'small', 'medium', 'large', or 'icon'",
    };
  }
  await browser.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: value });
  return { ok: true };
}

async function handleGetAutoSyncInterval(): Promise<unknown> {
  const result = await browser.storage.local.get([AUTO_SYNC_INTERVAL_KEY]);
  const stored = result[AUTO_SYNC_INTERVAL_KEY];
  const interval =
    stored === "daily" ||
    stored === "weekly" ||
    stored === "monthly" ||
    stored === "never"
      ? stored
      : "daily";
  return { interval };
}

async function handleSetAutoSyncInterval(
  message: Extract<BackgroundMessage, { type: "SET_AUTO_SYNC_INTERVAL" }>,
): Promise<unknown> {
  const value = message.interval;
  if (
    value !== "daily" &&
    value !== "weekly" &&
    value !== "monthly" &&
    value !== "never"
  ) {
    return {
      ok: false,
      error: "interval must be 'daily', 'weekly', 'monthly', or 'never'",
    };
  }
  await browser.storage.local.set({ [AUTO_SYNC_INTERVAL_KEY]: value });
  return { ok: true };
}

async function handleGetBookSort(
  message: Extract<BackgroundMessage, { type: "GET_BOOK_SORT" }>,
): Promise<unknown> {
  const shelf = message.shelf;
  if (shelf !== "family" && shelf !== "personal") {
    return { sort: "default" };
  }
  const key =
    shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
  const result = await browser.storage.local.get([key]);
  // Normalize legacy stored values (`title`/`author`) to their canonical
  // `-asc` form so persisted preferences survive the schema change.
  const sort = normalizeSortMode(result[key]);
  return { sort };
}

async function handleSetBookSort(
  message: Extract<BackgroundMessage, { type: "SET_BOOK_SORT" }>,
): Promise<unknown> {
  const shelf = message.shelf;
  const value = message.sort;
  if (shelf !== "family" && shelf !== "personal") {
    return { ok: false, error: "shelf must be 'family' or 'personal'" };
  }
  // Normalize accepts canonical values and legacy aliases; a value that is
  // neither maps to "default". Only an explicit "default" is a valid reason to
  // store "default" — reject any other unrecognized value rather than silently
  // downgrading a genuinely intended sort mode.
  const normalized = normalizeSortMode(value);
  if (normalized === "default" && value !== "default") {
    return { ok: false, error: "invalid sort mode" };
  }
  const key =
    shelf === "family" ? FAMILY_SHELF_SORT_KEY : PERSONAL_SHELF_SORT_KEY;
  await browser.storage.local.set({ [key]: normalized });
  return { ok: true };
}

function handleSetSyncErrorBadge(): unknown {
  showSyncErrorBadge();
  return { ok: true };
}

function handleClearSyncErrorBadge(): unknown {
  clearSyncErrorBadge();
  return { ok: true };
}

async function handleGetApiEndpoint(): Promise<unknown> {
  const result = await browser.storage.local.get([API_ENDPOINT_KEY]);
  return { apiEndpoint: result[API_ENDPOINT_KEY] ?? null };
}

async function handleSetApiEndpoint(
  message: Extract<BackgroundMessage, { type: "SET_API_ENDPOINT" }>,
): Promise<unknown> {
  const endpoint = message.apiEndpoint;
  if (endpoint === null || endpoint === undefined) {
    // Clear: remove custom endpoint, revert to default
    await browser.storage.local.remove(API_ENDPOINT_KEY);
    return { ok: 1 };
  }
  if (typeof endpoint === "string") {
    // Validate URL before storing
    try {
      const parsed = new URL(endpoint);
      const isHttps = parsed.protocol === "https:";
      const isLocalHttp =
        parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
      if (!isHttps && !isLocalHttp) {
        return { ok: 0, error: "Invalid protocol" };
      }
    } catch {
      return { ok: 0, error: "Invalid URL" };
    }
    await browser.storage.local.set({ [API_ENDPOINT_KEY]: endpoint });
    return { ok: 1 };
  }
  return { ok: 0, error: "Invalid endpoint value" };
}

/** Dispatch map: message type → handler. */
export const messageHandlers: MessageHandlerMap = {
  GET_FAMILY_ID: handleGetFamilyId,
  SET_FAMILY_ID: handleSetFamilyId,
  CLEAR_FAMILY_ID: handleClearFamilyId,
  GET_SYNC_ARCHIVED: handleGetSyncArchived,
  SET_SYNC_ARCHIVED: handleSetSyncArchived,
  GET_FLOATING_ICON_SIZE: handleGetFloatingIconSize,
  SET_FLOATING_ICON_SIZE: handleSetFloatingIconSize,
  GET_AUTO_SYNC_INTERVAL: handleGetAutoSyncInterval,
  SET_AUTO_SYNC_INTERVAL: handleSetAutoSyncInterval,
  GET_BOOK_SORT: handleGetBookSort,
  SET_BOOK_SORT: handleSetBookSort,
  SET_SYNC_ERROR_BADGE: handleSetSyncErrorBadge,
  CLEAR_SYNC_ERROR_BADGE: handleClearSyncErrorBadge,
  GET_API_ENDPOINT: handleGetApiEndpoint,
  SET_API_ENDPOINT: handleSetApiEndpoint,
};
