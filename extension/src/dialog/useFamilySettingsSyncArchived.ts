import { useCallback } from "react";
import { BoolFlag } from "../api/client";
import { useAccountSetting } from "./useAccountSetting";

export interface UseFamilySettingsSyncArchivedResult {
  syncArchived: BoolFlag;
  handleToggleSyncArchived: () => void;
  /** Text under the switch; `""` when there is nothing to report. */
  message: string;
}

/**
 * The 同步封存書籍 switch, an account setting shared with the PWA (#460): the
 * stored value on mount, each toggle saved to the server and switched back
 * when the save fails. Twin: `pwa/src/hooks/useAccountSyncArchived.ts`.
 */
export function useFamilySettingsSyncArchived(): UseFamilySettingsSyncArchivedResult {
  const { value, message, change } = useAccountSetting(
    "syncArchived",
    BoolFlag.FALSE,
  );

  const handleToggleSyncArchived = useCallback(() => {
    void change(value === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE);
  }, [change, value]);

  return { syncArchived: value, handleToggleSyncArchived, message };
}
