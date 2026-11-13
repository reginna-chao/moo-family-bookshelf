/** The pending-upload marker (#460): account settings changed where no request is sent (the options
 *  page), uploaded by the next Dialog open. See docs/architecture.md → 本機儲存與同步. */

import browser from "webextension-polyfill";
import {
  sanitizeAccountSettings,
  type AccountSettings,
  type AccountSettingsField,
} from "moo-family-bookshelf-shared/api/accountSettings";
import { ACCOUNT_SETTINGS_PENDING_KEY, USER_ID_KEY } from "../constants";

/** Stored shape of `ACCOUNT_SETTINGS_PENDING_KEY`: the account the values belong to, and the values. */
interface PendingMarker {
  userId: string;
  settings: AccountSettings;
}

function parseMarker(value: unknown): PendingMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const { userId, settings } = value as Record<string, unknown>;
  if (typeof userId !== "string" || userId === "") return null;
  return { userId, settings: sanitizeAccountSettings(settings) };
}

async function readMarker(): Promise<PendingMarker | null> {
  const stored = await browser.storage.local.get([
    ACCOUNT_SETTINGS_PENDING_KEY,
  ]);
  return parseMarker(stored[ACCOUNT_SETTINGS_PENDING_KEY]);
}

/**
 * Record `field = value` for upload by the next Dialog open, under the stored
 * userId. With no stored userId (onboarding not finished) nothing is recorded:
 * the value stays local only, and the first Dialog open either fills it in on
 * the server (no server value) or replaces it with the server's. A marker left
 * by another account is replaced whole.
 */
export async function writePendingAccountSetting<
  K extends AccountSettingsField,
>(field: K, value: NonNullable<AccountSettings[K]>): Promise<void> {
  const stored = await browser.storage.local.get([
    USER_ID_KEY,
    ACCOUNT_SETTINGS_PENDING_KEY,
  ]);
  const userId = stored[USER_ID_KEY];
  if (typeof userId !== "string" || userId === "") return;
  const marker = parseMarker(stored[ACCOUNT_SETTINGS_PENDING_KEY]);
  const base = marker?.userId === userId ? marker.settings : {};
  const next: PendingMarker = { userId, settings: { ...base, [field]: value } };
  await browser.storage.local.set({ [ACCOUNT_SETTINGS_PENDING_KEY]: next });
}

/** The pending values for `userId`; `{}` when the marker is absent, malformed or another account's. */
export async function readPendingAccountSettings(
  userId: string,
): Promise<AccountSettings> {
  const marker = await readMarker();
  return marker?.userId === userId ? marker.settings : {};
}

/**
 * Drop the pending fields of `userId` whose value still equals the one in
 * `sent`: a value written to the marker after `sent` was read stays for the
 * next upload. The key is removed once no field is left.
 */
export async function clearPendingAccountSettings(
  userId: string,
  sent: AccountSettings,
): Promise<void> {
  const marker = await readMarker();
  if (marker?.userId !== userId) return;
  // `marker.settings` holds only valid, present fields (`sanitizeAccountSettings`).
  const entries = Object.entries(marker.settings);
  const kept = entries.filter(
    ([field, value]) => sent[field as AccountSettingsField] !== value,
  );
  if (kept.length === entries.length) return;
  if (kept.length === 0) {
    await browser.storage.local.remove(ACCOUNT_SETTINGS_PENDING_KEY);
    return;
  }
  const settings = Object.fromEntries(kept) as AccountSettings;
  const next: PendingMarker = { userId, settings };
  await browser.storage.local.set({ [ACCOUNT_SETTINGS_PENDING_KEY]: next });
}
