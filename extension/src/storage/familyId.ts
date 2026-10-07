/** familyId reads: storage.local is authoritative; storage.sync is only a bootstrap hint for a
 *  never-onboarded device. Direct access, no background message: docs/architecture.md → 本機儲存與同步. */

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

  // Fall back to storage.sync only on a NEVER-onboarded device (no local userId); otherwise a missing
  // local familyId is authoritative "no family", never resurrected from a sync remnant.
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
