import { useState } from "react";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";
import {
  buildRetryMessage,
  buildStaticRetryMessage,
} from "@/utils/retryMessage";
import type { RetryErrorCode } from "@/utils/retryMessage";

export interface UseLandingRetryLockResult {
  /** Live back-off copy (with the countdown); empty when no notice is showing. */
  retryMessage: string;
  retryAnnouncement: string | undefined;
  retryBlocked: boolean;
  startRetryLock: (code: RetryErrorCode, retryAfter?: number) => void;
  clearRetryLock: () => void;
}

/** The landing page's 429 back-off notice and the countdown that lifts it. */
export function useLandingRetryLock(): UseLandingRetryLockResult {
  // Back-off state (429): the code drives the copy, the countdown the seconds.
  const [retryCode, setRetryCode] = useState<RetryErrorCode | null>(null);
  const retryCountdown = useRetryCountdown(() => setRetryCode(null));
  const retryMessage =
    retryCode === null
      ? ""
      : buildRetryMessage(retryCode, retryCountdown.remaining);
  /** Countdown-free twin of `retryMessage`, announced once instead of per tick.
   *  Undefined when no back-off notice is showing, so any other error copy —
   *  which never ticks — keeps announcing itself. */
  const retryAnnouncement =
    retryCode === null ? undefined : buildStaticRetryMessage(retryCode);
  /** True only while a countdown is running — blocks submit/verify actions. */
  const retryBlocked = retryCode !== null && retryCountdown.remaining > 0;

  /** Show a back-off notice; a positive `retryAfter` starts the live countdown. */
  function startRetryLock(code: RetryErrorCode, retryAfter?: number) {
    setRetryCode(code);
    retryCountdown.start(retryAfter ?? 0);
  }

  function clearRetryLock() {
    setRetryCode(null);
    retryCountdown.clear();
  }

  return {
    retryMessage,
    retryAnnouncement,
    retryBlocked,
    startRetryLock,
    clearRetryLock,
  };
}
