// A purely local 1 s ticker for a 429's `retryAfter`: no I/O (it only re-renders text); the interval
// lives only while a deadline is set and is cleared on unmount, on clear() and at zero.

import { useCallback, useEffect, useRef, useState } from "react";

/** 1-hour cap on any `retryAfter`: the official worker never asks for more than 900s, so this only
 *  stops a hostile or buggy self-hosted backend arming an endless ticker. */
const MAX_RETRY_WAIT_SECONDS = 3600;

export interface UseRetryCountdownResult {
  /** Remaining whole seconds, or null when no wait is active. */
  seconds: number | null;
  /** Begin (or restart) the countdown, capped at `MAX_RETRY_WAIT_SECONDS`; a missing / non-positive
   *  value is ignored so callers can forward the backend field. True when one started. */
  start: (retryAfterSeconds: number | undefined) => boolean;
  /** Stop any active countdown without invoking `onElapsed`. */
  clear: () => void;
}

/**
 * @param onElapsed Invoked once when the countdown reaches zero (e.g. to unlock
 *   the input). Called during the tick; the latest closure is always used.
 */
export function useRetryCountdown(
  onElapsed: () => void,
): UseRetryCountdownResult {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  // Keeps the effect keyed on `deadline` alone, so an unstable callback
  // identity cannot restart the interval mid-countdown.
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;

  useEffect(() => {
    if (deadline === null) return;
    // Remaining is derived from the deadline on every tick, so a background tab
    // throttling the interval only makes the display coarser, never wrong.
    const tick = (): void => {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) {
        setDeadline(null);
        setSeconds(null);
        onElapsedRef.current();
        return;
      }
      setSeconds(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const start = useCallback(
    (retryAfterSeconds: number | undefined): boolean => {
      if (
        typeof retryAfterSeconds !== "number" ||
        !Number.isFinite(retryAfterSeconds) ||
        retryAfterSeconds <= 0
      ) {
        return false;
      }
      const capped = Math.min(retryAfterSeconds, MAX_RETRY_WAIT_SECONDS);
      setDeadline(Date.now() + capped * 1000);
      return true;
    },
    [],
  );

  const clear = useCallback(() => {
    setDeadline(null);
    setSeconds(null);
  }, []);

  return { seconds, start, clear };
}
