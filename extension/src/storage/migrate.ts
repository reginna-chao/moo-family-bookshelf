/**
 * One-time storage key migration.
 *
 * TODO(cleanup): introduced in v1.3.0 for the one-off unprefixed → `moo:` key
 * rename. Safe to remove once nearly all installs have updated past v1.3.0
 * (target: ~v1.6.0 / 3 release cycles). Because the migration runs in
 * `onInstalled` on auto-update — not on user revisit — the tail is days/weeks,
 * not months. On removal, also drop the STORAGE_MIGRATED_KEY write; any leftover
 * legacy keys are harmless orphans not worth a second migration to clean.
 *
 * Historically, Extension storage keys were unprefixed (e.g. `userId`,
 * `familyId`). They are now namespaced with a `moo:` prefix to stay consistent
 * with the PWA. This migration renames any legacy (unprefixed) keys to their
 * new `moo:`-prefixed form in BOTH chrome.storage.local and chrome.storage.sync,
 * so existing users keep their auth token, family binding, and preferences
 * after the extension updates.
 *
 * Properties:
 * - Idempotent: keys already starting with `moo:` are skipped; safe to re-run.
 * - Crash-safe ordering: new keys are written BEFORE old keys are removed, so an
 *   interruption leaves data under the old keys (harmless) rather than losing it.
 * - Best-effort: any failure is swallowed so the background worker never crashes;
 *   the migration retries on the next startup because the flag stays unset.
 */

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

/**
 * Migrate legacy keys within a single storage area.
 * Writes new keys first, then removes the old ones.
 */
async function migrateArea(area: browser.Storage.StorageArea): Promise<void> {
  const all = await area.get(null);

  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (!isLegacyKey(key)) continue;
    const newKey = `${NEW_PREFIX}${key}`;
    // Never clobber an existing new-namespace value with a stale legacy one.
    // This can happen on a retry after a partial run (set succeeded, remove
    // failed) where the app has since written fresh data under the moo: key.
    // Only adopt the legacy value when the new key is absent; always drop legacy.
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
