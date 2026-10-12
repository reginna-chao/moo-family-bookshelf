/** Background message handlers: one per type, only that message's storage access + validation,
 *  RETURNING the response (polyfill convention); dispatch wiring lives in index.ts. */

import browser from "webextension-polyfill";
import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { readFamilyId } from "../storage/familyId";
import { showSyncErrorBadge, clearSyncErrorBadge } from "./badge";
import {
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
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
    // The shared validator the ApiClient and Dialog use — never a local copy (a stricter one here once
    // rejected LAN hosts the rest adopts). docs/architecture.md → 背景 Service Worker 與訊息.
    let normalized: string;
    try {
      normalized = validateEndpointUrl(endpoint);
    } catch (err) {
      return {
        ok: 0,
        error: err instanceof Error ? err.message : "Invalid API endpoint",
      };
    }
    // Store the canonical form, not the raw string, so this path and the
    // Dialog's direct write cannot leave two spellings of the same endpoint.
    await browser.storage.local.set({ [API_ENDPOINT_KEY]: normalized });
    return { ok: 1 };
  }
  return { ok: 0, error: "Invalid endpoint value" };
}

/** Dispatch map: message type → handler. */
export const messageHandlers: MessageHandlerMap = {
  GET_FAMILY_ID: handleGetFamilyId,
  SET_FAMILY_ID: handleSetFamilyId,
  CLEAR_FAMILY_ID: handleClearFamilyId,
  SET_SYNC_ERROR_BADGE: handleSetSyncErrorBadge,
  CLEAR_SYNC_ERROR_BADGE: handleClearSyncErrorBadge,
  GET_API_ENDPOINT: handleGetApiEndpoint,
  SET_API_ENDPOINT: handleSetApiEndpoint,
};
