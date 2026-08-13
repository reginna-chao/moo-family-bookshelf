/**
 * useVerificationPrompt — controller for the PWA-login verification challenge
 * that the backend (SEC-1) now demands from EXISTING members who reconnect via
 * `POST /api/family/:id/join`. It is flow-agnostic: any onboarding/recovery
 * join flow can hand it a verification error code plus a `retry` closure, and
 * the controller drives the prompt UI + re-submission.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import type { VerifyMethod } from "../api/types";
import { useRetryCountdown } from "./useRetryCountdown";
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "./verificationMessages";

const VERIFICATION_CODES = new Set([
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "VERIFICATION_LOCKED",
]);

/** True when a join errorCode is one the verification prompt should handle. */
export function isVerificationError(code: string | undefined): boolean {
  return code !== undefined && VERIFICATION_CODES.has(code);
}

export interface VerificationAttemptResult {
  ok: boolean;
  errorCode?: string;
  /**
   * Seconds the caller must wait before retrying, from the 429 body
   * (`error.retryAfter`). Optional: RATE_LIMITED always carries it, while
   * VERIFICATION_LOCKED only does on newer backends.
   */
  retryAfter?: number;
}

export interface VerificationContext {
  userId: string;
  /** Re-run the originating join flow with the collected secret. */
  retry: (verifySecret: string) => Promise<VerificationAttemptResult>;
  /** Restore the caller's view when the user abandons the prompt. */
  onCancel: () => void;
  /**
   * Restore the caller's view when an attempt did not succeed. `retry` often
   * moves the caller into a progress view ("recovering", "syncing-books", …)
   * that would hide the still-open prompt; this hook calls back once the
   * failure is confirmed AND the session is still live, so the restore can
   * never resurrect a prompt whose context has already been torn down.
   */
  onAttemptFailed?: () => void;
}

export interface UseVerificationPromptResult {
  active: boolean;
  method: VerifyMethod | null;
  /** True when the method could not be loaded for an active challenge (backend
   *  inconsistency). Distinct from a genuine OTP ("code") account so the UI can
   *  show a load-error message instead of the OTP guidance. */
  methodError: boolean;
  error: string;
  locked: boolean;
  submitting: boolean;
  /** Remaining seconds of a rate-limit / lockout wait, or null when the backend
   *  sent no `retryAfter` and no wait is being tracked. */
  countdownSeconds: number | null;
  /** Set up the prompt for a verification error code. Returns false (no-op) for
   *  non-verification codes so the caller falls back to its normal handling.
   *  `retryAfter` (seconds) starts the lockout countdown when available. */
  begin: (
    errorCode: string | undefined,
    ctx: VerificationContext,
    retryAfter?: number,
  ) => Promise<boolean>;
  submit: (secret: string) => Promise<void>;
  cancel: () => void;
}

export function useVerificationPrompt(
  apiClient: ApiClient,
): UseVerificationPromptResult {
  const [active, setActive] = useState(false);
  const [method, setMethod] = useState<VerifyMethod | null>(null);
  const [methodError, setMethodError] = useState(false);
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Mirrors `submitting` so submit() can reject a re-entrant call synchronously,
  // before the first attempt's await resolves — the state value would be stale
  // in the useCallback closure and let a second join fire.
  const submittingRef = useRef(false);
  const ctxRef = useRef<VerificationContext | null>(null);
  // Mirrors `method` so applyCode can skip a redundant fetch without depending
  // on the (stale-in-closure) state value.
  const methodRef = useRef<VerifyMethod | null>(null);
  // Guards post-await setState against unmount / reset / a new prompt session.
  const isMountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // A finished wait means the server window has cleared: drop the lock and the
  // stale message so the user can type again without reopening the prompt. If
  // the server still refuses, the next attempt brings a fresh retryAfter.
  const handleWaitElapsed = useCallback(() => {
    setLocked(false);
    setError("");
  }, []);

  const countdown = useRetryCountdown(handleWaitElapsed);
  const startCountdown = countdown.start;
  const clearCountdown = countdown.clear;

  // Arms the wait countdown from a 429 response, or clears any running one when
  // the response carried no usable `retryAfter`. Without the clear, a deadline
  // armed by an earlier 429 would survive into the new state: it would render
  // the wrong remaining wait and, on elapse, unlock a prompt that should have
  // stayed locked.
  const syncCountdown = useCallback(
    (retryAfter: number | undefined): void => {
      if (!startCountdown(retryAfter)) clearCountdown();
    },
    [startCountdown, clearCountdown],
  );

  const updateMethod = useCallback((next: VerifyMethod | null) => {
    methodRef.current = next;
    setMethod(next);
  }, []);

  const updateSubmitting = useCallback((next: boolean) => {
    submittingRef.current = next;
    setSubmitting(next);
  }, []);

  // Loads the verification method for an active challenge. A REQUIRED/FAILED/
  // LOCKED response means the user really has a pin/pattern/code method, so
  // missing data or "none" is a backend inconsistency → methodError, NOT the
  // OTP guidance path.
  const fetchMethod = useCallback(
    async (userId: string, generation: number): Promise<void> => {
      const res = await apiClient.getVerifyMethod(userId);
      if (!isMountedRef.current || generationRef.current !== generation) return;
      const loaded = res.data?.method;
      if (loaded === "pin" || loaded === "pattern" || loaded === "code") {
        updateMethod(loaded);
        setMethodError(false);
        return;
      }
      updateMethod(null);
      setMethodError(true);
    },
    [apiClient, updateMethod],
  );

  const applyCode = useCallback(
    async (
      code: string | undefined,
      userId: string,
      generation: number,
      retryAfter?: number,
    ): Promise<void> => {
      if (code === "VERIFICATION_LOCKED") {
        setLocked(true);
        // Static copy; the live variant is rendered from countdownSeconds.
        setError(verificationLockedMessage(null));
        // No retryAfter (older backend) → locked stays until the user leaves,
        // so any countdown from an earlier 429 must be dropped here.
        syncCountdown(retryAfter);
      } else if (code === "VERIFICATION_FAILED") {
        setLocked(false);
        setError("驗證失敗，請重新輸入");
        clearCountdown();
      } else {
        // VERIFICATION_REQUIRED
        setLocked(false);
        setError("");
        clearCountdown();
      }
      // Any active challenge needs a method to render the right input; fetch it
      // once if unknown so the prompt never dead-loads on "載入中…".
      if (methodRef.current === null) {
        await fetchMethod(userId, generation);
      }
    },
    [fetchMethod, syncCountdown, clearCountdown],
  );

  const reset = useCallback(() => {
    generationRef.current += 1;
    setActive(false);
    updateMethod(null);
    setMethodError(false);
    setError("");
    setLocked(false);
    updateSubmitting(false);
    clearCountdown();
    ctxRef.current = null;
  }, [updateMethod, updateSubmitting, clearCountdown]);

  const begin = useCallback(
    async (
      errorCode: string | undefined,
      ctx: VerificationContext,
      retryAfter?: number,
    ): Promise<boolean> => {
      if (!isVerificationError(errorCode)) return false;
      const generation = ++generationRef.current;
      ctxRef.current = ctx;
      setActive(true);
      updateSubmitting(false);
      setMethodError(false);
      updateMethod(null);
      // applyCode restarts or clears the countdown for the new generation.
      await applyCode(errorCode, ctx.userId, generation, retryAfter);
      return true;
    },
    [applyCode, updateMethod, updateSubmitting],
  );

  const submit = useCallback(
    async (secret: string): Promise<void> => {
      const ctx = ctxRef.current;
      // submittingRef guards re-entry: a fast second onComplete (pattern/PIN
      // resubmitted while the first join is in flight) must not fire a second
      // network join. The ref is set synchronously below, so the racing call
      // sees it before the first attempt's await resolves.
      if (!ctx || locked || submittingRef.current) return;
      const generation = generationRef.current;
      updateSubmitting(true);
      // The retry closure runs a whole onboarding flow (lookup + join +
      // browser.storage writes + book sync), any step of which can reject.
      // An escaping rejection would skip updateSubmitting(false) and strand
      // the prompt on 「驗證中…」, so contain it here rather than relying on
      // every caller's closure being defensive.
      let result: VerificationAttemptResult;
      try {
        result = await ctx.retry(secret);
      } catch {
        if (!isMountedRef.current || generationRef.current !== generation) {
          return;
        }
        ctx.onAttemptFailed?.();
        updateSubmitting(false);
        clearCountdown();
        setError("發生錯誤，請稍後再試");
        return;
      }
      if (!isMountedRef.current || generationRef.current !== generation) return;
      updateSubmitting(false);
      if (result.ok) {
        // The retry closure owns the success side-effects (navigation, sync).
        // No onAttemptFailed here: the flow has navigated away, and forcing the
        // prompt back would render it over an already-completed journey.
        reset();
        return;
      }
      // The prompt stays open on every failure branch below, so bring the
      // caller's view back to it before applying the new prompt state.
      ctx.onAttemptFailed?.();
      if (isVerificationError(result.errorCode)) {
        await applyCode(
          result.errorCode,
          ctx.userId,
          generation,
          result.retryAfter,
        );
        return;
      }
      if (result.errorCode === "RATE_LIMITED") {
        // Server rate limit hit (429) — per-IP sensitive tier, or the verify
        // attempt ceiling on a wrong secret. Keep the prompt open so the user
        // can retry once the window clears, with a specific message.
        setError(rateLimitedMessage(null));
        syncCountdown(result.retryAfter);
        return;
      }
      clearCountdown();
      setError("發生錯誤，請稍後再試");
    },
    [locked, applyCode, reset, updateSubmitting, syncCountdown, clearCountdown],
  );

  const cancel = useCallback(() => {
    const ctx = ctxRef.current;
    reset();
    ctx?.onCancel();
  }, [reset]);

  return {
    active,
    method,
    methodError,
    error,
    locked,
    submitting,
    countdownSeconds: countdown.seconds,
    begin,
    submit,
    cancel,
  };
}
