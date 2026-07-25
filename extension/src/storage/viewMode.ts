/**
 * Shared Family Shelf view-mode read/write helpers.
 *
 * Reads/writes FAMILY_SHELF_VIEW_MODE_KEY directly from browser.storage.local.
 * Normalization: only an exact stored "row" maps to "row"; any other value
 * (including unset or legacy data) falls back to "grid".
 *
 * Why storage.local only (no storage.sync, unlike familyId): the Family Shelf
 * view mode is a purely local UI preference. It should not follow the user
 * across devices, so there is no reason to mirror it into storage.sync.
 *
 * Why direct storage access instead of background messaging: Firefox's MV3
 * background is a non-persistent event page that sleeps. Message round-trips to
 * it (browser.runtime.sendMessage) can reject or resolve undefined while the
 * page is asleep, whereas browser.storage.* stays reliable in the Dialog
 * context. The familyId helper (storage/familyId.ts) follows this same pattern
 * to dodge the same class of Firefox-only bug.
 */

import browser from "webextension-polyfill";
import { FAMILY_SHELF_VIEW_MODE_KEY } from "../constants";

export type FamilyShelfViewMode = "grid" | "row";

export async function readFamilyShelfViewMode(): Promise<FamilyShelfViewMode> {
  const result = await browser.storage.local.get([FAMILY_SHELF_VIEW_MODE_KEY]);
  return result[FAMILY_SHELF_VIEW_MODE_KEY] === "row" ? "row" : "grid";
}

export async function writeFamilyShelfViewMode(
  mode: FamilyShelfViewMode,
): Promise<void> {
  await browser.storage.local.set({ [FAMILY_SHELF_VIEW_MODE_KEY]: mode });
}
