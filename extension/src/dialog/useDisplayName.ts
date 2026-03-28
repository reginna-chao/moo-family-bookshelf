import { useState, useEffect, useCallback } from "react";
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
  handleSaveDisplayName: () => Promise<void>;
}

export function useDisplayName(options?: UseDisplayNameOptions): UseDisplayNameResult {
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");
  const [nameSaveState, setNameSaveState] = useState<NameSaveState>("idle");
  const [nameSaveError, setNameSaveError] = useState("");

  useEffect(() => {
    chrome.storage.local.get(["displayName"], (result) => {
      const name = (result.displayName as string | undefined) ?? "";
      setDisplayName(name);
      setSavedDisplayName(name);
    });
  }, []);

  const handleSaveDisplayName = useCallback(async () => {
    const trimmed = displayName.trim();
    setNameSaveState("saving");
    setNameSaveError("");

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
        return;
      }
    }

    await chrome.storage.local.set({ displayName: trimmed });
    await chrome.storage.sync.set({ displayName: trimmed });
    setDisplayName(trimmed);
    setSavedDisplayName(trimmed);
    setNameSaveState("saved");
    setTimeout(() => setNameSaveState("idle"), 1500);
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
