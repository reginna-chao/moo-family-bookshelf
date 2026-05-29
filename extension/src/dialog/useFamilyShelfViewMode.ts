import { useCallback, useEffect, useRef, useState } from "react";

export type FamilyShelfViewMode = "grid" | "row";

const DEFAULT_VIEW_MODE: FamilyShelfViewMode = "grid";

function isViewMode(value: unknown): value is FamilyShelfViewMode {
  return value === "grid" || value === "row";
}

export interface UseFamilyShelfViewModeReturn {
  viewMode: FamilyShelfViewMode;
  setViewMode: (mode: FamilyShelfViewMode) => void;
}

export function useFamilyShelfViewMode(): UseFamilyShelfViewModeReturn {
  const [viewMode, setViewModeState] = useState<FamilyShelfViewMode>(DEFAULT_VIEW_MODE);
  const viewModeRef = useRef(viewMode);

  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "GET_FAMILY_SHELF_VIEW_MODE" },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (isViewMode(response?.viewMode)) {
          setViewModeState(response.viewMode);
        }
      },
    );
  }, []);

  const setViewMode = useCallback((mode: FamilyShelfViewMode) => {
    const prev = viewModeRef.current;
    if (prev === mode) return;
    setViewModeState(mode);
    chrome.runtime.sendMessage(
      { type: "SET_FAMILY_SHELF_VIEW_MODE", viewMode: mode },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setViewModeState(prev);
        }
      },
    );
  }, []);

  return { viewMode, setViewMode };
}
