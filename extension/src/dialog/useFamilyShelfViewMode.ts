import { useCallback, useEffect, useState } from "react";
import {
  readFamilyShelfViewMode,
  writeFamilyShelfViewMode,
  type FamilyShelfViewMode,
} from "../storage/viewMode";

export type { FamilyShelfViewMode };

const DEFAULT_VIEW_MODE: FamilyShelfViewMode = "grid";

export interface UseFamilyShelfViewModeReturn {
  viewMode: FamilyShelfViewMode;
  setViewMode: (mode: FamilyShelfViewMode) => void;
}

export function useFamilyShelfViewMode(): UseFamilyShelfViewModeReturn {
  const [viewMode, setViewModeState] = useState<FamilyShelfViewMode>(DEFAULT_VIEW_MODE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readFamilyShelfViewMode();
        if (!cancelled) {
          setViewModeState(stored);
        }
      } catch {
        // storage.local unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setViewMode = useCallback(
    (mode: FamilyShelfViewMode) => {
      if (viewMode === mode) return;
      setViewModeState(mode);
      // Fire-and-forget: direct storage.local writes in the dialog context are
      // reliable, so we do NOT roll the UI back on a storage hiccup — a lost
      // persistence is better UX than snapping the view back under the user.
      void writeFamilyShelfViewMode(mode).catch(() => {
        // Ignore write failures; UI state remains authoritative.
      });
    },
    [viewMode],
  );

  return { viewMode, setViewMode };
}
