/** 同步封存書 flag, read/written DIRECTLY in storage.local (a local-only device preference): only an
 *  exact BoolFlag.TRUE reads as TRUE, anything else as FALSE. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { SYNC_ARCHIVED_KEY } from "../constants";

export async function readSyncArchived(): Promise<BoolFlag> {
  const result = await browser.storage.local.get([SYNC_ARCHIVED_KEY]);
  return result[SYNC_ARCHIVED_KEY] === BoolFlag.TRUE
    ? BoolFlag.TRUE
    : BoolFlag.FALSE;
}

export async function writeSyncArchived(value: BoolFlag): Promise<void> {
  await browser.storage.local.set({ [SYNC_ARCHIVED_KEY]: value });
}
