import { useCallback, useEffect, useRef, useState } from "react";

export type FloatingIconSize = "small" | "medium" | "large" | "icon";

const DEFAULT_SIZE: FloatingIconSize = "medium";

function isSize(value: unknown): value is FloatingIconSize {
  return value === "small" || value === "medium" || value === "large" || value === "icon";
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
    chrome.runtime.sendMessage(
      { type: "GET_FLOATING_ICON_SIZE" },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (isSize(response?.size)) {
          setSizeState(response.size);
        }
      },
    );
  }, []);

  const setSize = useCallback((next: FloatingIconSize) => {
    const prev = sizeRef.current;
    if (prev === next) return;
    setSizeState(next);
    chrome.runtime.sendMessage(
      { type: "SET_FLOATING_ICON_SIZE", size: next },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setSizeState(prev);
        }
      },
    );
  }, []);

  return { size, setSize };
}
