import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient, BoolFlag } from "../api/client";

/** Every status but `ready` keeps the switch disabled; `noRecord` = no books record until the first sync. */
export type NewBookDefaultStatus =
  "loading" | "ready" | "loadFailed" | "noRecord" | "unsupported";

export interface UseFamilySettingsNewBookDefaultResult {
  newBookDefaultShared: BoolFlag;
  status: NewBookDefaultStatus;
  /** A toggle is on its way to the server. */
  saving: boolean;
  /** Text under the switch; "" when there is nothing to report. */
  message: string;
  handleToggleNewBookDefault: () => void;
}

const LOAD_FAILED_MESSAGE = "載入設定失敗，請稍後再試";
const SAVE_FAILED_MESSAGE = "儲存失敗，請稍後再試";
/** A PUT 404 = a self-hosted server that predates this setting. */
const UNSUPPORTED_MESSAGE = "伺服器尚未支援這個設定";
const NO_RECORD_MESSAGE = "同步一次書單後就能設定";

function messageFor(status: NewBookDefaultStatus): string {
  if (status === "loadFailed") return LOAD_FAILED_MESSAGE;
  if (status === "noRecord") return NO_RECORD_MESSAGE;
  if (status === "unsupported") return UNSUPPORTED_MESSAGE;
  return "";
}

/** What the mount read found: the stored flag (`ready`), no record, or a failed read. */
interface StoredRead {
  status: "ready" | "noRecord" | "loadFailed";
  flag: BoolFlag;
}

/** Read the stored setting. Never throws. */
async function readStoredFlag(
  apiClient: ApiClient,
  userId: string,
): Promise<StoredRead> {
  try {
    const res = await apiClient.getPersonalBooks(userId);
    if (res.error) return { status: "loadFailed", flag: BoolFlag.FALSE };
    // `data: null` = no record yet; GET merges the setting only into an existing record.
    if (res.data === null) return { status: "noRecord", flag: BoolFlag.FALSE };
    // Not coerced by `sanitizePersonalBooksText`: anything but TRUE reads as off.
    const on = res.data?.newBookDefaultShared === BoolFlag.TRUE;
    return { status: "ready", flag: on ? BoolFlag.TRUE : BoolFlag.FALSE };
  } catch {
    return { status: "loadFailed", flag: BoolFlag.FALSE };
  }
}

/** Save the setting; resolves to the error code, or null on success. Never throws. */
async function saveFlag(
  apiClient: ApiClient,
  userId: string,
  flag: BoolFlag,
): Promise<string | null> {
  try {
    const res = await apiClient.updateNewBookDefault(userId, flag);
    return res.error ? String(res.error.code) : null;
  } catch {
    return "CLIENT_ERROR";
  }
}

/**
 * The 新書預設開放 switch (#238). The value lives in the server record, so it
 * is read once when the settings view mounts (no polling) and each toggle is
 * saved straight away: optimistic, rolled back when the save fails.
 */
export function useFamilySettingsNewBookDefault(
  apiClient: ApiClient,
  userId: string,
): UseFamilySettingsNewBookDefaultResult {
  const [flag, setFlag] = useState<BoolFlag>(BoolFlag.FALSE);
  const [status, setStatus] = useState<NewBookDefaultStatus>("loading");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void readStoredFlag(apiClient, userId).then((stored) => {
      if (cancelled) return;
      setFlag(stored.flag);
      setStatus(stored.status);
    });
    return () => {
      cancelled = true;
    };
  }, [apiClient, userId]);

  const handleToggleNewBookDefault = useCallback(() => {
    if (status !== "ready" || saving) return;
    const previous = flag;
    const next = flag === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    setFlag(next);
    setSaving(true);
    setSaveError("");
    void saveFlag(apiClient, userId, next).then((errorCode) => {
      if (!mountedRef.current) return;
      setSaving(false);
      if (errorCode === null) return;
      setFlag(previous);
      if (errorCode === "NOT_FOUND") setStatus("unsupported");
      else setSaveError(SAVE_FAILED_MESSAGE);
    });
  }, [apiClient, userId, flag, status, saving]);

  return {
    newBookDefaultShared: flag,
    status,
    saving,
    message: saveError || messageFor(status),
    handleToggleNewBookDefault,
  };
}
