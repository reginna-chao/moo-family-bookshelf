/** Family Shelf view mode, read/written DIRECTLY in storage.local (a local-only UI preference): only an
 *  exact "row" reads as "row", anything else as "grid". See docs/architecture.md → 本機儲存與同步. */

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
