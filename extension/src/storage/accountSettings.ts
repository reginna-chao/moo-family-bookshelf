/** The four account settings (#460) in storage.local: a cache of the server record, which the
 *  background, the content script and sync keep reading. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import {
  ACCOUNT_SETTINGS_FIELDS,
  sanitizeAccountSettings,
  type AccountSettings,
  type AccountSettingsField,
} from "moo-family-bookshelf-shared/api/accountSettings";
import {
  AUTO_SYNC_INTERVAL_KEY,
  FLOATING_ICON_SIZE_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  SYNC_ARCHIVED_KEY,
  USER_ID_KEY,
} from "../constants";

/** The storage.local key each account setting is cached under. */
export const ACCOUNT_SETTING_KEYS: Readonly<
  Record<AccountSettingsField, string>
> = {
  syncArchived: SYNC_ARCHIVED_KEY,
  autoSyncInterval: AUTO_SYNC_INTERVAL_KEY,
  storePageChipEnabled: STORE_PAGE_CHIP_ENABLED_KEY,
  floatingIconSize: FLOATING_ICON_SIZE_KEY,
};

const ACCOUNT_SETTING_STORAGE_KEYS = ACCOUNT_SETTINGS_FIELDS.map(
  (field) => ACCOUNT_SETTING_KEYS[field],
);

/** Re-key a storage read by field name, then keep only the valid values. */
function fromStorage(stored: Record<string, unknown>): AccountSettings {
  const raw: Record<string, unknown> = {};
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    raw[field] = stored[ACCOUNT_SETTING_KEYS[field]];
  }
  return sanitizeAccountSettings(raw);
}

/**
 * The settings this browser holds a valid stored value for, in one storage
 * read. No defaults are filled in: a field never written (or holding an
 * unknown value) is absent, and that absence is what marks a setting this
 * browser never adjusted. Rejects only when storage itself is unavailable.
 */
export async function readStoredAccountSettings(): Promise<AccountSettings> {
  const stored = await browser.storage.local.get(ACCOUNT_SETTING_STORAGE_KEYS);
  return fromStorage(stored);
}

/** Write one setting straight to storage.local (the local-only path, or a server-confirmed value). */
export async function writeLocalAccountSetting<K extends AccountSettingsField>(
  field: K,
  value: NonNullable<AccountSettings[K]>,
): Promise<void> {
  await browser.storage.local.set({ [ACCOUNT_SETTING_KEYS[field]]: value });
}

/**
 * Cache the server's values for `userId`: one read and at most one write.
 * Writes nothing unless the stored userId is still `userId` (the binding can
 * change while a request is out), and writes only the fields whose stored
 * value differs, so an unchanged setting fires no `storage.onChanged`.
 */
export async function writeFollowedAccountSettings(
  userId: string,
  settings: AccountSettings,
): Promise<void> {
  const stored = await browser.storage.local.get([
    USER_ID_KEY,
    ...ACCOUNT_SETTING_STORAGE_KEYS,
  ]);
  if (stored[USER_ID_KEY] !== userId) return;
  const changed: Record<string, unknown> = {};
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    const value = settings[field];
    const key = ACCOUNT_SETTING_KEYS[field];
    if (value !== undefined && stored[key] !== value) changed[key] = value;
  }
  if (Object.keys(changed).length === 0) return;
  await browser.storage.local.set(changed);
}
