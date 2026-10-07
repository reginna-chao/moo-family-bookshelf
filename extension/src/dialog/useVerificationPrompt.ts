// Flow-agnostic controller for the PWA-login verification challenge (SEC-1) on members' joins: a flow
// hands it a verification code plus a `retry` closure, and it drives the prompt and re-submission.

import { useCallback, useEffect, useRef, useState } from "react";
import { isFamilyGoneError } from "../api/auth-refresh";
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
  /** Seconds to wait before retrying (429 `error.retryAfter`): RATE_LIMITED always carries it,
   *  VERIFICATION_LOCKED only on newer backends. */
  retryAfter?: number;
  /** The backend's user-facing message, if sent; handed to `onFamilyGone` so a terminal refusal is
   *  explained in the server's own words. */
  errorMessage?: string;
}

export interface VerificationContext {
  userId: string;
  /** Re-run the originating join flow with the collected secret. */
  retry: (verifySecret: string) => Promise<VerificationAttemptResult>;
  /** Restore the caller's view when the user abandons the prompt. */
  onCancel: () => void;
  /** Restore the caller's view after a failed attempt (`retry` may enter a progress view hiding the
   *  prompt); called only once failure is confirmed AND the session is still live. */
  onAttemptFailed?: () => void;
  /** The join target is gone for this user (deleted / full / removed): no secret can succeed, so the
   *  prompt tears down and the caller owns the side effects. Omitted → generic failure handling. */
  onFamilyGone?: (
    errorCode: string,
    errorMessage?: string,
  ) => void | Promise<void>;
}

export interface UseVerificationPromptResult {
  active: boolean;
  method: VerifyMethod | null;
  /** True when an active challenge's method failed to load (backend inconsistency) — distinct from a
   *  genuine OTP ("code") account, so the UI shows a load error, not the OTP guidance. */
  methodError: boolean;
  error: string;
  locked: boolean;
  submitting: boolean;
  /** Remaining seconds of a rate-limit / lockout wait, or null when the backend
   *  sent no `retryAfter` and no wait is being tracked. */
  countdownSeconds: number | null;
  /** Set up the prompt for a verification code (false, a no-op, for any other so the caller handles
   *  it); `retryAfter` (seconds) starts the lockout countdown when available. */
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
  // Mirrors `submitting` so submit() rejects re-entry synchronously; the state value is stale in the
  // useCallback closure and would let a second join fire.
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

  // A finished wait means the server window cleared: unlock and drop the stale message (a renewed
  // refusal brings a fresh retryAfter).
  const handleWaitElapsed = useCallback(() => {
    setLocked(false);
    setError("");
  }, []);

  const countdown = useRetryCountdown(handleWaitElapsed);
  const startCountdown = countdown.start;
  const clearCountdown = countdown.clear;

  // Arm the countdown from a 429, or clear a running one without a usable `retryAfter`: a stale deadline
  // would show the wrong wait and, on elapse, unlock a prompt that should stay locked.
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

  // A REQUIRED/FAILED/LOCKED code means a real pin/pattern/code method, so missing data or "none" is a
  // backend inconsistency → methodError, NOT the OTP guidance path.
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
      // A fast second onComplete while the first join is in flight must not fire another join; the
      // ref is set synchronously below, before the first attempt's await resolves.
      if (!ctx || locked || submittingRef.current) return;
      const generation = generationRef.current;
      updateSubmitting(true);
      // `retry` runs a whole flow (lookup, join, storage writes, book sync) that can reject; contain it
      // here, or updateSubmitting(false) is skipped and the prompt stuck on 「驗證中…」.
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
        // `retry` owns the success side effects; no onAttemptFailed, which would put the prompt back
        // over a completed journey.
        reset();
        return;
      }
      // Terminal for this user: close instead of inviting a retry that always fails. BEFORE
      // onAttemptFailed on purpose — it would restore a flow that is about to unwind.
      if (isFamilyGoneError(result.errorCode) && ctx.onFamilyGone) {
        reset();
        try {
          await ctx.onFamilyGone(result.errorCode, result.errorMessage);
        } catch (err) {
          // Contained like `retry`: caller teardown can reject, which must not reject submit(); the
          // prompt is already reset, so log only.
          console.warn("[Verification] onFamilyGone handler failed", err);
        }
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
        // 429 (per-IP sensitive tier, or the verify ceiling on a wrong secret): keep the prompt open
        // with a specific message so the user retries once the window clears.
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
