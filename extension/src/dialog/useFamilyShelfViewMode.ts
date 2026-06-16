import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";

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
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_FAMILY_SHELF_VIEW_MODE",
        })) as { viewMode?: unknown } | undefined;
        if (cancelled) return;
        if (isViewMode(response?.viewMode)) {
          setViewModeState(response.viewMode);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setViewMode = useCallback((mode: FamilyShelfViewMode) => {
    const prev = viewModeRef.current;
    if (prev === mode) return;
    setViewModeState(mode);
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_FAMILY_SHELF_VIEW_MODE",
          viewMode: mode,
        })) as { ok?: boolean } | undefined;
        if (!response?.ok) {
          setViewModeState(prev);
        }
      } catch {
        setViewModeState(prev);
      }
    })();
  }, []);

  return { viewMode, setViewMode };
}
