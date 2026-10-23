import browser from "webextension-polyfill";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
} from "../constants";

/** Persist auth/family credentials to chrome.storage.local — familyId DIRECTLY, not only via the
 *  background SET_FAMILY_ID message, which Firefox's sleeping event page can lose. */
export async function persistJoinCredentials(opts: {
  userId: string;
  familyId?: string;
  authToken?: string;
  expiresAt?: number;
}): Promise<void> {
  const storageData: Record<string, unknown> = {
    [USER_ID_KEY]: opts.userId,
  };
  if (opts.familyId !== undefined) {
    storageData[FAMILY_ID_KEY] = opts.familyId;
  }
  if (opts.authToken !== undefined) {
    storageData[AUTH_TOKEN_KEY] = opts.authToken;
  }
  if (opts.expiresAt) {
    storageData[TOKEN_EXPIRES_AT_KEY] = opts.expiresAt;
  }
  await browser.storage.local.set(storageData);
}
