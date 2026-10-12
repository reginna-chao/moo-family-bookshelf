/** Auto-sync frequency, read/written DIRECTLY in storage.local (a local-only device preference): any
 *  value outside the four options reads as the default. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import { AUTO_SYNC_INTERVAL_KEY } from "../constants";

/** User-configurable auto-sync frequency */
export type AutoSyncInterval = "daily" | "weekly" | "monthly" | "never";

export const DEFAULT_AUTO_SYNC_INTERVAL: AutoSyncInterval = "daily";

/** Type guard for AutoSyncInterval */
export function isAutoSyncInterval(v: unknown): v is AutoSyncInterval {
  return v === "daily" || v === "weekly" || v === "monthly" || v === "never";
}

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
