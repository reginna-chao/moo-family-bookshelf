import { useState, useEffect, useCallback } from "react";

type NameSaveState = "idle" | "saving" | "saved";

export interface UseDisplayNameResult {
  displayName: string;
  savedDisplayName: string;
  nameSaveState: NameSaveState;
  setDisplayName: (name: string) => void;
  handleSaveDisplayName: () => Promise<void>;
}

export function useDisplayName(): UseDisplayNameResult {
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");
  const [nameSaveState, setNameSaveState] = useState<NameSaveState>("idle");

  useEffect(() => {
    chrome.storage.local.get(["displayName"], (result) => {
      const name = (result.displayName as string | undefined) ?? "";
      setDisplayName(name);
      setSavedDisplayName(name);
    });
  }, []);

  const handleSaveDisplayName = useCallback(async () => {
    setNameSaveState("saving");
    await chrome.storage.local.set({ displayName });
    await chrome.storage.sync.set({ displayName });
    setSavedDisplayName(displayName);
    setNameSaveState("saved");
    setTimeout(() => setNameSaveState("idle"), 1500);
  }, [displayName]);

  return {
    displayName,
    savedDisplayName,
    nameSaveState,
    setDisplayName,
    handleSaveDisplayName,
  };
}
