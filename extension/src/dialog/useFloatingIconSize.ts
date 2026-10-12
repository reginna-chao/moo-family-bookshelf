import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_FLOATING_ICON_SIZE,
  readFloatingIconSize,
  writeFloatingIconSize,
  type FloatingIconSize,
} from "../storage/floatingIconSize";

export type { FloatingIconSize };

export interface UseFloatingIconSizeReturn {
  size: FloatingIconSize;
  setSize: (size: FloatingIconSize) => void;
}

export function useFloatingIconSize(): UseFloatingIconSizeReturn {
  const [size, setSizeState] = useState<FloatingIconSize>(
    DEFAULT_FLOATING_ICON_SIZE,
  );
  // Set once the user picks a value, so a mount read that resolves later cannot overwrite it.
  const userChoseRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readFloatingIconSize();
        if (!cancelled && !userChoseRef.current) {
          setSizeState(stored);
        }
      } catch {
        // storage.local unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSize = useCallback(
    (next: FloatingIconSize) => {
      if (size === next) return;
      userChoseRef.current = true;
      setSizeState(next);
      // Fire-and-forget, no rollback: direct storage.local writes are reliable here, and losing the
      // persistence beats snapping the choice back under the user.
      void writeFloatingIconSize(next).catch(() => {
        // Ignore write failures; UI state remains authoritative.
      });
    },
    [size],
  );

  return { size, setSize };
}
