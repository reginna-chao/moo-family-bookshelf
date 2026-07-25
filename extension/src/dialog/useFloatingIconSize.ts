import { useCallback, useEffect, useRef, useState } from "react";
import browser from "webextension-polyfill";

export type FloatingIconSize = "small" | "medium" | "large" | "icon";

const DEFAULT_SIZE: FloatingIconSize = "medium";

function isSize(value: unknown): value is FloatingIconSize {
  return (
    value === "small" ||
    value === "medium" ||
    value === "large" ||
    value === "icon"
  );
}

export interface UseFloatingIconSizeReturn {
  size: FloatingIconSize;
  setSize: (size: FloatingIconSize) => void;
}

export function useFloatingIconSize(): UseFloatingIconSizeReturn {
  const [size, setSizeState] = useState<FloatingIconSize>(DEFAULT_SIZE);
  const sizeRef = useRef(size);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_FLOATING_ICON_SIZE",
        })) as { size?: unknown } | undefined;
        if (cancelled) return;
        if (isSize(response?.size)) {
          setSizeState(response.size);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSize = useCallback((next: FloatingIconSize) => {
    const prev = sizeRef.current;
    if (prev === next) return;
    setSizeState(next);
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_FLOATING_ICON_SIZE",
          size: next,
        })) as { ok?: boolean } | undefined;
        if (!response?.ok) {
          setSizeState(prev);
        }
      } catch {
        setSizeState(prev);
      }
    })();
  }, []);

  return { size, setSize };
}
