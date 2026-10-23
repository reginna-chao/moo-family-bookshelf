/** Removes the Readmoo email older versions kept in storage.local (#359); nothing writes it any more.
 *  Run from `onInstalled`, so an existing install is purged on the update that ships this. */

import browser from "webextension-polyfill";
import { USER_EMAIL_KEY } from "../constants";

// Pre-June-2026 Chrome installs never had this unprefixed key renamed to USER_EMAIL_KEY.
const LEGACY_USER_EMAIL_KEY = "userEmail";

/** Best-effort removal of both email keys in one call; never rejects. */
export async function purgeStoredEmail(): Promise<void> {
  try {
    await browser.storage.local.remove([USER_EMAIL_KEY, LEGACY_USER_EMAIL_KEY]);
  } catch {
    console.warn("[Background] storage.local.remove failed for stored email");
  }
}
