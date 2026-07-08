import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A boolean flag that auto-resets to `false` after `durationMs`. Calling the
 * returned `trigger` sets it `true` and (re)arms the reset timer. The timer is
 * cleared on unmount, so no setState runs after the component is gone.
 *
 * Useful for transient UI feedback such as a "已複製" confirmation.
 */
export function useTimedFlag(durationMs: number): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  const trigger = useCallback(() => {
    setActive(true);
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setActive(false), durationMs);
  }, [durationMs]);

  return [active, trigger];
}
