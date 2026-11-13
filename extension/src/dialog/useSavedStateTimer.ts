import { useCallback, useEffect, useRef } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface SavedStateTimer {
  /** Cancel the pending reset, if any. */
  clearSavedTimer: () => void;
  /** Run `onElapsed` after 2000 ms, replacing any pending reset. */
  startSavedTimer: (onElapsed: () => void) => void;
}

/** The pending "saved" → "idle" reset; cleared on unmount and before rescheduling. */
export function useSavedStateTimer(): SavedStateTimer {
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSavedTimer = useCallback(() => {
    if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
  }, []);

  const startSavedTimer = useCallback(
    (onElapsed: () => void) => {
      clearSavedTimer();
      savedTimerRef.current = setTimeout(onElapsed, 2000);
    },
    [clearSavedTimer],
  );

  useEffect(() => clearSavedTimer, [clearSavedTimer]);

  return { clearSavedTimer, startSavedTimer };
}
