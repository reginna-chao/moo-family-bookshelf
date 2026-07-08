import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a stable debounced version of `fn`. Each invocation resets a
 * `delayMs` timer; only the last call within the window actually runs `fn`.
 * The pending timer is cleared on unmount, so a queued call can never fire
 * after the component is gone (prevents post-unmount network writes / setState).
 *
 * `fn` is read through a ref, so the returned function stays referentially
 * stable while always calling the latest closure.
 */
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (...args: Args) => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fnRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  );
}
