/** Auto-sync frequency in storage.local, a cache of the account setting (#460): any value outside the
 *  four options reads as the default. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import {
  isAutoSyncInterval,
  type AutoSyncInterval,
} from "moo-family-bookshelf-shared/api/accountSettingsValues";
import { AUTO_SYNC_INTERVAL_KEY } from "../constants";

// The type and guard live in `shared/` (the Worker checks the same four values); re-exported here.
export { isAutoSyncInterval, type AutoSyncInterval };

export const DEFAULT_AUTO_SYNC_INTERVAL: AutoSyncInterval = "daily";

export async function readAutoSyncInterval(): Promise<AutoSyncInterval> {
  const result = await browser.storage.local.get([AUTO_SYNC_INTERVAL_KEY]);
  const stored = result[AUTO_SYNC_INTERVAL_KEY];
  return isAutoSyncInterval(stored) ? stored : DEFAULT_AUTO_SYNC_INTERVAL;
}

export async function writeAutoSyncInterval(
  interval: AutoSyncInterval,
): Promise<void> {
  await browser.storage.local.set({ [AUTO_SYNC_INTERVAL_KEY]: interval });
}
