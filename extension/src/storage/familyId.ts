/**
 * Shared familyId read helper.
 *
 * Reads FAMILY_ID_KEY from browser.storage.sync first, falling back to
 * browser.storage.local. Returns null when neither area has the key.
 *
 * Why sync-first-fallback-local: familyId is mirrored into storage.sync so it
 * follows the user across devices, but local is the reliable source of truth
 * that every write also targets. Reading sync first surfaces a value synced
 * from another device; local covers the common case and Firefox, where sync may
 * be empty or unavailable.
 *
 * Why the try/catch: storage.sync can reject in Firefox (no signed-in account,
 * Android limits, or the pref disabled). A sync failure must never break the
 * read, so it is isolated and we silently fall through to local on any error.
 *
 * This lives in the storage layer (not the background) so the Dialog can read
 * familyId via DIRECT storage access — Firefox's non-persistent background event
 * page sleeps and its message round-trips fail, while storage.* stays reliable.
 */

import browser from "webextension-polyfill";
import { FAMILY_ID_KEY } from "../constants";

export async function readFamilyId(): Promise<string | null> {
  try {
    const syncResult = await browser.storage.sync.get([FAMILY_ID_KEY]);
    const synced = syncResult[FAMILY_ID_KEY];
    if (typeof synced === "string") {
      return synced;
    }
  } catch {
    // sync storage unavailable (e.g. Firefox without sync); fall back to local
  }
  const localResult = await browser.storage.local.get([FAMILY_ID_KEY]);
  const local = localResult[FAMILY_ID_KEY];
  return typeof local === "string" ? local : null;
}
