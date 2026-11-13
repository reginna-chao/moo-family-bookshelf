// Local (this device only) teardown of the family binding, for leaving a family (App) and for
// switching to the logged-in Readmoo account (AccountMismatchScreen, #271). Neither calls the API.

import browser from "webextension-polyfill";
import type { ApiClient } from "../api/client";
import {
  USER_ID_KEY,
  STORED_TOKEN_KEYS,
  FAMILY_ID_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
  DEFAULT_API_ENDPOINT,
  STORE_PAGE_INDEX_KEY,
} from "../constants";
import { FAMILY_ENDPOINT_CHOICE_KEYS } from "../storage/familyEndpointChoice";
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

async function removeSyncFamilyId(): Promise<void> {
  try {
    await browser.storage.sync.remove(FAMILY_ID_KEY);
  } catch {
    // sync storage may be unavailable (e.g. Firefox without sync)
  }
}

/**
 * Remove familyId + auth credentials from storage DIRECTLY — the Dialog never
 * routes this through a background message — so Unbind Isolation rests on
 * this removal alone.
 *
 * The API endpoint is a FAMILY-scoped setting — the owner picks it, every
 * member adopts it — so its stored choice goes too, in the SAME local removal:
 * a failed removal keeps the family AND its endpoint, and a self-hosted token
 * that another tab's join wrote can never be left behind without its endpoint
 * (#492). The `CLEAR_FAMILY_ID` background message (background/messageHandlers.ts)
 * may later remove familyId + token as well; that only takes the token away,
 * never leaves a token without its endpoint, and goes once PR #489 removes the
 * message. The caller resets the live client (see storage/familyEndpointChoice.ts
 * for why a family-less client must not stay on the old family's server).
 *
 * The store-page chip index (family names + book ids) goes with the binding;
 * the chip switch is the user's own setting and stays.
 *
 * Every removal is started synchronously; rejects if the local removal fails.
 * Only the storage.sync removal is best-effort.
 */
export async function clearStoredFamilyBinding(
  extraLocalKeys: readonly string[] = [],
): Promise<void> {
  const syncRemoval = removeSyncFamilyId();
  await browser.storage.local.remove([
    FAMILY_ID_KEY,
    ...STORED_TOKEN_KEYS,
    STORE_PAGE_INDEX_KEY,
    ...FAMILY_ENDPOINT_CHOICE_KEYS,
    ...extraLocalKeys,
  ]);
  await syncRemoval;
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
