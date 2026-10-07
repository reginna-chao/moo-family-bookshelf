/** One-time rename of legacy unprefixed storage keys to `moo:` (local + sync); idempotent, crash-safe,
 *  best-effort. TODO(cleanup): removal plan in docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import { STORAGE_MIGRATED_KEY } from "../constants";

const NEW_PREFIX = "moo:";

/** Legacy (unprefixed) static keys that must be migrated. */
const LEGACY_STATIC_KEYS: ReadonlySet<string> = new Set([
  "userId",
  "authToken",
  "tokenExpiresAt",
  "familyId",
  "displayName",
  "userEmail",
  "apiEndpoint",
  "hasCompletedInitialSetup",
  "syncArchived",
  "autoSyncInterval",
  "lastSyncAt",
  "lastDisplayScrapeAt",
  "familyShelfViewMode",
  "floatingIconSize",
  "familyShelfSort",
  "personalShelfSort",
  "manualLendNoticeDismissed",
  "personalShelfSavedAt",
  "personalBooksCache",
]);

/** Legacy dynamic key prefixes (followed by a per-user suffix). */
const LEGACY_DYNAMIC_PREFIXES: readonly string[] = [
  "familyBookshelfSeen:",
  "familyBookshelfChips:",
];

/** Whether a legacy key should be migrated to the `moo:` namespace. */
function isLegacyKey(key: string): boolean {
  if (key.startsWith(NEW_PREFIX)) return false;
  if (LEGACY_STATIC_KEYS.has(key)) return true;
  return LEGACY_DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Migrate legacy keys within one storage area: new keys are written first, then old ones removed. */
async function migrateArea(area: browser.Storage.StorageArea): Promise<void> {
  const all = await area.get(null);

  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (!isLegacyKey(key)) continue;
    const newKey = `${NEW_PREFIX}${key}`;
    // Never clobber a moo: value with a stale legacy one (a retry after a partial run may find fresh
    // data there): adopt legacy only when the new key is absent; always drop legacy.
    if (!(newKey in all)) {
      toSet[newKey] = value;
    }
    toRemove.push(key);
  }

  if (toRemove.length === 0) return;

  if (Object.keys(toSet).length > 0) {
    await area.set(toSet);
  }
  await area.remove(toRemove);
}

/**
 * Migrate all legacy storage keys to the `moo:` namespace.
 * No-op once the migration flag is set.
 */
export async function migrateStorageKeys(): Promise<void> {
  try {
    const flag = await browser.storage.local.get(STORAGE_MIGRATED_KEY);
    if (flag[STORAGE_MIGRATED_KEY]) return;

    await migrateArea(browser.storage.local);

    try {
      await migrateArea(browser.storage.sync);
    } catch {
      // sync storage may be unavailable in some contexts — local migration still counts
    }

    await browser.storage.local.set({ [STORAGE_MIGRATED_KEY]: true });
  } catch {
    // Best-effort: never crash the background worker. Retries next startup
    // because the migration flag stays unset.
  }
}
