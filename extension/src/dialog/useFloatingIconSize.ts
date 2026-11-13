import { useCallback } from "react";
import {
  DEFAULT_FLOATING_ICON_SIZE,
  type FloatingIconSize,
} from "../storage/floatingIconSize";
import { useAccountSetting } from "./useAccountSetting";

export type { FloatingIconSize };

export interface UseFloatingIconSizeReturn {
  size: FloatingIconSize;
  setSize: (size: FloatingIconSize) => void;
  /** Text under the selector; `""` when there is nothing to report. */
  message: string;
}

/** The 家庭書櫃按鈕大小 selector, an account setting (#460); picking the current size sends nothing. */
export function useFloatingIconSize(): UseFloatingIconSizeReturn {
  const { value, message, change } = useAccountSetting(
    "floatingIconSize",
    DEFAULT_FLOATING_ICON_SIZE,
  );

  const setSize = useCallback(
    (next: FloatingIconSize) => {
      void change(next);
    },
    [change],
  );

  return { size: value, setSize, message };
}
