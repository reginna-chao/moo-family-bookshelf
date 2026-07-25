import { useCallback, useEffect, useState } from "react";
import { namespacedKey } from "@/hooks/useAuth";

export type FamilyShelfViewMode = "grid" | "row";

function readViewMode(storageKey: string): FamilyShelfViewMode {
  const stored = localStorage.getItem(storageKey);
  return stored === "row" ? "row" : "grid";
}

export interface UseFamilyShelfViewModeReturn {
  viewMode: FamilyShelfViewMode;
  setViewMode: (mode: FamilyShelfViewMode) => void;
}

export function useFamilyShelfViewMode(
  userId: string,
): UseFamilyShelfViewModeReturn {
  const storageKey = namespacedKey(userId, "familyShelfViewMode");

  const [viewMode, setViewModeState] = useState<FamilyShelfViewMode>(() =>
    readViewMode(storageKey),
  );

  useEffect(() => {
    setViewModeState(readViewMode(storageKey));
  }, [storageKey]);

  const setViewMode = useCallback(
    (mode: FamilyShelfViewMode) => {
      localStorage.setItem(storageKey, mode);
      setViewModeState(mode);
    },
    [storageKey],
  );

  return { viewMode, setViewMode };
}
