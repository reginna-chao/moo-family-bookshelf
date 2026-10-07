// Local (this device only) teardown of the family binding, for leaving a family (App) and for
// switching to the logged-in Readmoo account (AccountMismatchScreen, #271). Neither calls the API.

import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
  DEFAULT_API_ENDPOINT,
} from "../constants";
import { resetFamilyEndpointChoice } from "../storage/familyEndpointChoice";
import { forgetAccountConfirmation } from "./accountIdentityCheck";

/** Account keys dropped on top of the family binding. The books cache holds that account's share
 *  flags, which onboarding would upload as the NEXT account's books (personalBooksCacheMigration.ts). */
const ACCOUNT_LOCAL_KEYS = [
  USER_ID_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
];

/** Best-effort: Firefox's sleeping background page can drop this message. */
function notifyBackgroundFamilyCleared(): void {
  try {
    void Promise.resolve(
      browser.runtime.sendMessage({ type: "CLEAR_FAMILY_ID" }),
    ).catch(() => {});
  } catch {
    // Background unreachable — the direct storage removal below is authoritative.
  }
}

async function removeSyncFamilyId(): Promise<void> {
  try {
    await browser.storage.sync.remove(FAMILY_ID_KEY);
  } catch {
    // sync storage may be unavailable (e.g. Firefox without sync)
  }
}

/**
 * Remove familyId + auth credentials from storage DIRECTLY (the background
 * message can fail in Firefox), so Unbind Isolation never depends on it.
 *
 * The API endpoint is a FAMILY-scoped setting — the owner picks it, every
 * member adopts it — so its stored choice goes too, but only once the local
 * removal has landed: a failed removal keeps the family AND its endpoint. The
 * caller resets the live client (see storage/familyEndpointChoice.ts for why a
 * family-less client must not stay on the old family's server).
 *
 * Every removal is started synchronously; rejects if the local removal fails.
 * The background message and the storage.sync removal are best-effort.
 */
export async function clearStoredFamilyBinding(
  extraLocalKeys: readonly string[] = [],
): Promise<void> {
  notifyBackgroundFamilyCleared();
  const syncRemoval = removeSyncFamilyId();
  await browser.storage.local.remove([
    FAMILY_ID_KEY,
    AUTH_TOKEN_KEY,
    TOKEN_EXPIRES_AT_KEY,
    ...extraLocalKeys,
  ]);
  await Promise.all([resetFamilyEndpointChoice(), syncRemoval]);
}

/**
 * Forget the stored account on THIS device: the family binding plus the keys
 * that name the account, then the live client's token/endpoint and the
 * page-load confirmation. No API call — that account keeps its family
 * membership and its server data. Rejects (client untouched) if storage fails.
 */
export async function forgetStoredAccount(apiClient: ApiClient): Promise<void> {
  await clearStoredFamilyBinding(ACCOUNT_LOCAL_KEYS);
  apiClient.setAuthToken(null);
  apiClient.setEndpoint(DEFAULT_API_ENDPOINT);
  forgetAccountConfirmation();
}
