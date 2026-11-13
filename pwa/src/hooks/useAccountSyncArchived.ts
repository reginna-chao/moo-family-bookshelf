import { useCallback, useEffect, useRef, useState } from "react";
import { BoolFlag } from "@/api/client";
import type { ApiClient } from "@/api/client";
import { namespacedKey } from "@/hooks/useAuth";
import {
  ACCOUNT_SETTINGS_LOCAL_ONLY,
  ACCOUNT_SETTINGS_SAVE_FAILED,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";

export interface UseAccountSyncArchivedResult {
  syncArchived: BoolFlag;
  /** Text under the switch; `""` when there is nothing to report. */
  message: string;
  toggle: () => void;
}

/** What the mount read found; `absent` = the account has no value yet (the PWA never fills one in). */
type ServerRead =
  | { kind: "value"; flag: BoolFlag }
  | { kind: "absent" }
  | { kind: "unsupported" }
  | { kind: "failed" };

function cacheKey(userId: string): string {
  return namespacedKey(userId, "syncArchived");
}

function readCached(userId: string): BoolFlag {
  return localStorage.getItem(cacheKey(userId)) === "1"
    ? BoolFlag.TRUE
    : BoolFlag.FALSE;
}

function writeCached(userId: string, flag: BoolFlag): void {
  localStorage.setItem(cacheKey(userId), String(flag));
}

/** Read the account's value. Never throws: a partial client or a network error is `failed`. */
async function readServerFlag(
  apiClient: ApiClient,
  userId: string,
): Promise<ServerRead> {
  try {
    const res = await apiClient.accountSettings.get(userId);
    if (res.error) {
      return res.error.code === "NOT_FOUND"
        ? { kind: "unsupported" }
        : { kind: "failed" };
    }
    const flag = res.data?.syncArchived;
    return flag === undefined ? { kind: "absent" } : { kind: "value", flag };
  } catch {
    return { kind: "failed" };
  }
}

/** Save the account's value; resolves to the error code, or null on success. Never throws. */
async function saveServerFlag(
  apiClient: ApiClient,
  userId: string,
  flag: BoolFlag,
): Promise<string | null> {
  try {
    const res = await apiClient.accountSettings.patch(userId, {
      settings: { syncArchived: flag },
    });
    return res.error ? String(res.error.code) : null;
  } catch {
    return "CLIENT_ERROR";
  }
}

/**
 * The 同步封存書籍 switch, an account setting shared with the Extension (#460).
 * localStorage is the cache shown first; each mount then reads the server once,
 * and a reply arriving after the user toggled is dropped. Each toggle is saved
 * at once and switched back when the save fails; a 404 (a server without this
 * feature) keeps every change local. Never sends `ifAbsent`. Twin:
 * `extension/src/dialog/useFamilySettingsSyncArchived.ts`.
 */
export function useAccountSyncArchived(
  userId: string,
  apiClient: ApiClient,
): UseAccountSyncArchivedResult {
  const [syncArchived, setSyncArchived] = useState<BoolFlag>(() =>
    readCached(userId),
  );
  const [message, setMessage] = useState("");
  const [localOnly, setLocalOnly] = useState(false);
  const userChoseRef = useRef(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readServerFlag(apiClient, userId).then((read) => {
      // After a toggle the reply is stale (it may even predate the save): keep the user's choice.
      if (cancelled || userChoseRef.current) return;
      if (read.kind === "value") {
        setSyncArchived(read.flag);
        writeCached(userId, read.flag);
      } else if (read.kind === "unsupported") {
        setLocalOnly(true);
        setMessage(ACCOUNT_SETTINGS_LOCAL_ONLY);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userId, apiClient]);

  const toggle = useCallback(() => {
    if (savingRef.current) return;
    const previous = syncArchived;
    const next =
      syncArchived === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    userChoseRef.current = true;
    setSyncArchived(next);
    writeCached(userId, next);
    if (localOnly) {
      setMessage(ACCOUNT_SETTINGS_LOCAL_ONLY);
      return;
    }
    savingRef.current = true;
    setMessage("");
    void saveServerFlag(apiClient, userId, next).then((errorCode) => {
      savingRef.current = false;
      if (errorCode === null) return;
      if (errorCode === "NOT_FOUND") {
        if (!mountedRef.current) return;
        setLocalOnly(true);
        setMessage(ACCOUNT_SETTINGS_LOCAL_ONLY);
        return;
      }
      // The server kept the old value: so does the cache, even when this page has gone.
      writeCached(userId, previous);
      if (!mountedRef.current) return;
      setSyncArchived(previous);
      setMessage(ACCOUNT_SETTINGS_SAVE_FAILED);
    });
  }, [userId, apiClient, syncArchived, localOnly]);

  return { syncArchived, message, toggle };
}
