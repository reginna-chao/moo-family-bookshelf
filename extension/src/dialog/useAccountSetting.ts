import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";
import {
  sanitizeAccountSettings,
  type AccountSettings,
  type AccountSettingsField,
} from "moo-family-bookshelf-shared/api/accountSettings";
import { ACCOUNT_SETTINGS_SAVE_FAILED } from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import {
  ACCOUNT_SETTING_KEYS,
  readStoredAccountSettings,
  writeLocalAccountSetting,
} from "../storage/accountSettings";
import { useAccountSettingsSync } from "./AccountSettingsContext";
import type {
  AccountSettingsSaveOutcome,
  AccountSettingsSync,
} from "./accountSettingsSync";

/** `skipped`: the value was already selected, or a save of this setting is still in flight. */
export type AccountSettingChangeOutcome =
  AccountSettingsSaveOutcome | "skipped";

export interface UseAccountSettingResult<V> {
  value: V;
  /** A change is on its way to the server. */
  saving: boolean;
  /** Text under the setting; `""` when there is nothing to report. */
  message: string;
  change: (next: V) => Promise<AccountSettingChangeOutcome>;
}

/** Without a provider (no controller) the value goes to storage.local only, as before #460. */
async function saveSetting<K extends AccountSettingsField>(
  sync: AccountSettingsSync | null,
  field: K,
  next: NonNullable<AccountSettings[K]>,
): Promise<AccountSettingsSaveOutcome> {
  if (sync !== null) return sync.save(field, next);
  await writeLocalAccountSetting(field, next).catch(() => {});
  return "localOnly";
}

/**
 * One account setting (#460) on screen: the stored value (or `fallback`),
 * followed through `storage.onChanged` while no save is in flight, and an
 * optimistic `change` that switches back when the server refuses the save
 * (`failed`, with `ACCOUNT_SETTINGS_SAVE_FAILED`) or the response belongs to a
 * closed Dialog or another server (`stale`, silently).
 */
export function useAccountSetting<K extends AccountSettingsField>(
  field: K,
  fallback: NonNullable<AccountSettings[K]>,
): UseAccountSettingResult<NonNullable<AccountSettings[K]>> {
  type Value = NonNullable<AccountSettings[K]>;
  const sync = useAccountSettingsSync();
  const [value, setValue] = useState<Value>(fallback);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  // Set once the user changes the value, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readStoredAccountSettings()
      .then((stored) => {
        if (cancelled || userChoseRef.current) return;
        setValue(stored[field] ?? fallback);
      })
      .catch(() => {
        // storage.local unavailable — keep the fallback
      });
    const key = ACCOUNT_SETTING_KEYS[field];
    const listener = (
      changes: Record<string, browser.Storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local" || !Object.hasOwn(changes, key)) return;
      if (savingRef.current) return;
      const changed = sanitizeAccountSettings({
        [field]: changes[key].newValue,
      });
      setValue(changed[field] ?? fallback);
    };
    try {
      browser.storage.onChanged.addListener(listener);
    } catch {
      // Extension context may be invalidated
    }
    return () => {
      cancelled = true;
      try {
        browser.storage.onChanged.removeListener(listener);
      } catch {
        // Extension context may be invalidated
      }
    };
  }, [field, fallback]);

  const change = useCallback(
    async (next: Value): Promise<AccountSettingChangeOutcome> => {
      if (next === value || savingRef.current) return "skipped";
      const previous = value;
      userChoseRef.current = true;
      savingRef.current = true;
      setValue(next);
      setSaving(true);
      setMessage("");
      const outcome = await saveSetting(sync, field, next);
      savingRef.current = false;
      if (!mountedRef.current) return outcome;
      setSaving(false);
      if (outcome === "failed") {
        setValue(previous);
        setMessage(ACCOUNT_SETTINGS_SAVE_FAILED);
      } else if (outcome === "stale") {
        setValue(previous);
      }
      return outcome;
    },
    [field, sync, value],
  );

  return { value, saving, message, change };
}
