import { useCallback, useEffect, useRef, useState } from "react";

const MS_PER_SECOND = 1000;

/**
 * Upper bound for a backend-supplied wait, in seconds (1 hour).
 *
 * `retryAfter` is attacker- / misconfiguration-influenced input: the API host is
 * user-configurable (BYO backend), so a hostile or buggy deployment could answer
 * a 429 with an absurd value and freeze the UI for days. The official Worker
 * never exceeds 900s, so clamping here costs nothing in normal operation.
 */
const MAX_RETRY_AFTER_SECONDS = 3600;

export interface RetryCountdown {
  /** Whole seconds left before a retry is allowed; 0 when idle. */
  remaining: number;
  /**
   * Arm (or re-arm) the countdown. A non-positive input only clears it, and a
   * value above one hour is clamped (see `MAX_RETRY_AFTER_SECONDS`).
   */
  start: (seconds: number) => void;
  /** Stop the countdown without firing `onExpire`. */
  clear: () => void;
}

/**
 * Counts down to a retry deadline, ticking once per second. Purely local UI
 * state — no network work happens on a tick.
 *
 * Timer hygiene: at most one interval exists, and only while a deadline is
 * armed. It is cleared on unmount, when superseded by another `start`, and when
 * it reaches zero (at which point `onExpire` fires exactly once).
 *
 * The remaining value is derived from a wall-clock deadline instead of being
 * decremented, so a throttled background tab resumes with the correct value.
 *
 * `onExpire` is held in a ref, so passing an inline closure is safe.
 */
export function useRetryCountdown(onExpire?: () => void): RetryCountdown {
  const [remaining, setRemaining] = useState(0);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onExpireRef.current = onExpire;
  });

  const stopTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
    deadlineRef.current = 0;
  }, []);

  useEffect(() => stopTimer, [stopTimer]);

  const clear = useCallback(() => {
    stopTimer();
    setRemaining(0);
  }, [stopTimer]);

  const start = useCallback(
    (seconds: number) => {
      stopTimer();
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setRemaining(0);
        return;
      }

      const total = Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
      deadlineRef.current = Date.now() + total * MS_PER_SECOND;
      setRemaining(total);
      timerRef.current = setInterval(() => {
        const left = Math.ceil(
          (deadlineRef.current - Date.now()) / MS_PER_SECOND,
        );
        if (left > 0) {
          setRemaining(left);
          return;
        }
        stopTimer();
        setRemaining(0);
        onExpireRef.current?.();
      }, MS_PER_SECOND);
    },
    [stopTimer],
  );

  return { remaining, start, clear };
}
