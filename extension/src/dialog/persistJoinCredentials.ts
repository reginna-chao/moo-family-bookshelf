import browser from "webextension-polyfill";
import {
  API_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  TOKEN_SERVER_KEY,
  FAMILY_ID_KEY,
} from "../constants";
import { tokenServerMarker } from "../api/tokenBinding";

/** Persist auth/family credentials to chrome.storage.local — familyId written directly; the Dialog
 *  never routes storage writes through the background (docs/architecture.md → 本機儲存與同步).
 *
 *  A token is written in the same `set` as the server that issued it, so the pair changes atomically,
 *  and a rejected `set` changes nothing. For the official default the key is then removed; a rejected
 *  removal is only logged, because the pair is correct and the join succeeded. No token issued: the
 *  endpoint key is not touched. See docs/architecture.md → 認證更新與冷卻. */
export async function persistJoinCredentials(opts: {
  userId: string;
  familyId?: string;
  authToken?: string;
  expiresAt?: number;
  /** The server this request was sent to, read before it went out; never the client's endpoint after the response. */
  endpoint: string;
}): Promise<void> {
  const storageData: Record<string, unknown> = {
    [USER_ID_KEY]: opts.userId,
  };
  if (opts.familyId !== undefined) {
    storageData[FAMILY_ID_KEY] = opts.familyId;
  }
  if (opts.authToken !== undefined) {
    storageData[AUTH_TOKEN_KEY] = opts.authToken;
    storageData[TOKEN_SERVER_KEY] = tokenServerMarker(opts.endpoint);
    storageData[API_ENDPOINT_KEY] = opts.endpoint;
  }
  if (opts.expiresAt) {
    storageData[TOKEN_EXPIRES_AT_KEY] = opts.expiresAt;
  }
  await browser.storage.local.set(storageData);
  if (opts.authToken !== undefined && opts.endpoint === DEFAULT_API_ENDPOINT) {
    await dropOfficialEndpointKey();
  }
}

// No key means the official default, so a new official URL still reaches this device. Removed only
// after the pair is written: the official token never pairs with another server. Why: 認證更新與冷卻.
async function dropOfficialEndpointKey(): Promise<void> {
  try {
    await browser.storage.local.remove([API_ENDPOINT_KEY]);
  } catch (err) {
    console.warn(
      "[persistJoinCredentials] Could not remove the official endpoint key",
      err,
    );
  }
}
