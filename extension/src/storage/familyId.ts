/**
 * Shared familyId read helpers.
 *
 * Precedence: storage.local is the AUTHORITATIVE store — every write targets it,
 * and it is the reliable area in Firefox (where storage.sync may be empty or
 * unavailable). storage.sync is only a cross-device bootstrap HINT, consulted
 * exclusively for a device that has never onboarded.
 *
 * Why local-first (not sync-first): a failed silent recovery clears the local
 * familyId but a stale familyId can linger in storage.sync (and on Android
 * Firefox `storage.sync.remove` can silently no-op). Reading sync first would
 * resurrect that "zombie" familyId on every dialog open, forcing the user back
 * into a broken main view with no path to onboarding. Local-first kills that:
 * once a device has onboarded (USER_ID_KEY present locally), a missing local
 * familyId means "no family" — we never resurrect it from sync.
 *
 * This lives in the storage layer (not the background) so the Dialog can read
 * familyId via DIRECT storage access — Firefox's non-persistent background event
 * page sleeps and its message round-trips fail, while storage.* stays reliable.
 */

import browser from "webextension-polyfill";
import { FAMILY_ID_KEY, USER_ID_KEY } from "../constants";

export async function readFamilyId(): Promise<string | null> {
  const localResult = await browser.storage.local.get([
    FAMILY_ID_KEY,
    USER_ID_KEY,
  ]);
  const local = localResult[FAMILY_ID_KEY];
  if (typeof local === "string") {
    return local;
  }

  // Local has no familyId. Only fall back to storage.sync when this device has
  // NEVER onboarded (no local userId); otherwise a missing local familyId is
  // authoritative "no family" and must NOT be resurrected from a sync remnant.
  if (typeof localResult[USER_ID_KEY] === "string") {
    return null;
  }

  try {
    const syncResult = await browser.storage.sync.get([FAMILY_ID_KEY]);
    const synced = syncResult[FAMILY_ID_KEY];
    if (typeof synced === "string") {
      return synced;
    }
  } catch {
    // sync storage unavailable (e.g. Firefox without sync); treat as no family
  }
  return null;
}

/**
 * Read a familyId that survives ONLY in storage.sync — the "zombie" remnant
 * left behind when a failed silent recovery cleared the local familyId while a
 * stale value lingered in sync. Returns the sync familyId ONLY when this device
 * has already onboarded (local USER_ID_KEY present) but has no local familyId,
 * and sync still holds one. Used to PRE-FILL (never auto-submit) the onboarding
 * sync-code input so the user can rejoin in one tap. Returns null otherwise.
 */
export async function readSyncFamilyIdRemnant(): Promise<string | null> {
  const localResult = await browser.storage.local.get([
    USER_ID_KEY,
    FAMILY_ID_KEY,
  ]);
  if (typeof localResult[USER_ID_KEY] !== "string") return null; // never onboarded
  if (typeof localResult[FAMILY_ID_KEY] === "string") return null; // local familyId present

  try {
    const syncResult = await browser.storage.sync.get([FAMILY_ID_KEY]);
    const synced = syncResult[FAMILY_ID_KEY];
    return typeof synced === "string" ? synced : null;
  } catch {
    return null;
  }
}
