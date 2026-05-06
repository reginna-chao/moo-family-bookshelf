import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient } from "../api/client";

type NameSaveState = "idle" | "saving" | "saved" | "error";

export interface UseDisplayNameOptions {
  apiClient?: ApiClient;
  familyId?: string;
  userId?: string;
}

export interface UseDisplayNameResult {
  displayName: string;
  savedDisplayName: string;
  nameSaveState: NameSaveState;
  nameSaveError: string;
  setDisplayName: (name: string) => void;
  handleSaveDisplayName: () => Promise<boolean>;
}

export function useDisplayName(options?: UseDisplayNameOptions): UseDisplayNameResult {
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");
  const [nameSaveState, setNameSaveState] = useState<NameSaveState>("idle");
  const [nameSaveError, setNameSaveError] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlightRef = useRef(false);

  useEffect(() => {
    // 1. Optimistic: show local cache immediately to avoid flicker
    chrome.storage.local.get(["displayName"], (result) => {
      const cached = (result.displayName as string | undefined) ?? "";
      if (cached) {
        setDisplayName(cached);
        setSavedDisplayName(cached);
      }
    });

    // 2. Fetch authoritative value from server
    if (options?.apiClient && options.familyId && options.userId) {
      const { apiClient, familyId, userId } = options;
      (async () => {
        try {
          const res = await apiClient.getFamilyMembers(familyId);
          if (res.error || !res.data) return;
          const self = res.data.members.find((m) => m.userId === userId);
          const serverName = self?.displayName ?? "";
          // Only update if server has a value (empty means never set — keep local)
          if (serverName) {
            setDisplayName(serverName);
            setSavedDisplayName(serverName);
            await chrome.storage.local.set({ displayName: serverName });
            await chrome.storage.sync.set({ displayName: serverName });
          }
        } catch {
          // Server fetch failed — keep local cache, no user-visible error needed
        }
      })();
    }

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [options?.apiClient, options?.familyId, options?.userId]);

  const handleSaveDisplayName = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;

    const trimmed = displayName.trim();
    setNameSaveState("saving");
    setNameSaveError("");

    try {
      // Call API if available
      if (options?.apiClient && options.familyId && options.userId) {
        const response = await options.apiClient.updateDisplayName(
          options.familyId,
          options.userId,
          trimmed,
        );
        if (response.error) {
          setNameSaveError(response.error.message);
          setNameSaveState("error");
          return false;
        }
      }

      await chrome.storage.local.set({ displayName: trimmed });
      await chrome.storage.sync.set({ displayName: trimmed });
      setDisplayName(trimmed);
      setSavedDisplayName(trimmed);
      setNameSaveState("saved");
      timeoutRef.current = setTimeout(() => setNameSaveState("idle"), 1500);
      return true;
    } catch (err) {
      setNameSaveError(err instanceof Error ? err.message : "儲存失敗");
      setNameSaveState("error");
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [displayName, options?.apiClient, options?.familyId, options?.userId]);

  return {
    displayName,
    savedDisplayName,
    nameSaveState,
    nameSaveError,
    setDisplayName,
    handleSaveDisplayName,
  };
}
