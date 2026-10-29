import { useState, useEffect, useCallback, useRef } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "../api/client";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";
import type { SaveState } from "./useVerifyMethodFlow";

export interface UseOtpCodeOptions {
  userId: string;
  apiClient: ApiClient;
  clearSavedTimer: () => void;
  setSaveState: (state: SaveState) => void;
  setSaveError: (error: string) => void;
}

export interface UseOtpCodeResult {
  otpCode: string | null;
  otpExpiresAt: number | null;
  otpCountdown: number;
  /** Drops the shown code (a method change hides it). */
  resetOtp: () => void;
  handleGenerateOtp: () => Promise<void>;
}

/** The settings panel's one-time code: generation, the shown code and its expiry countdown. */
export function useOtpCode({
  userId,
  apiClient,
  clearSavedTimer,
  setSaveState,
  setSaveError,
}: UseOtpCodeOptions): UseOtpCodeResult {
  // OTP state
  const [otpCode, setOtpCode] = useState<string | null>(null);
  const [otpExpiresAt, setOtpExpiresAt] = useState<number | null>(null);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // OTP countdown timer
  useEffect(() => {
    if (!otpExpiresAt) return;
    function tick() {
      const remaining = Math.max(
        0,
        Math.floor(((otpExpiresAt ?? 0) - Date.now()) / 1000),
      );
      setOtpCountdown(remaining);
      if (remaining <= 0) {
        setOtpCode(null);
        setOtpExpiresAt(null);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    }
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [otpExpiresAt]);

  const resetOtp = useCallback(() => {
    setOtpCode(null);
    setOtpExpiresAt(null);
  }, []);

  const handleGenerateOtp = useCallback(async () => {
    // A new OTP generation supersedes any pending saved→idle reset: the stale
    // timer would dismiss this handler's own failure banner mid-flight.
    clearSavedTimer();

    setSaveState("idle");
    setSaveError("");
    const result = await apiClient.generateOtp(userId);
    // Bare-cast envelope: a non-string code crashes render, a non-finite expiry breaks the countdown,
    // so either fails the generation. See docs/architecture.md → 驗證碼的產生.
    const code: unknown = result.data?.code;
    const expiresAt: unknown = result.data?.expiresAt;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      setSaveState("error");
      // A real 429 (verify-write ceiling) gets the shared back-off copy; there may be no error at
      // all, since this branch also catches a success envelope with malformed fields.
      setSaveError(
        (result.error ? rateLimitedEnvelopeMessage(result.error) : null) ??
          safeErrorText(result.error?.message, "驗證碼產生失敗，請重試"),
      );
      return;
    }
    setOtpCode(code);
    setOtpExpiresAt(expiresAt);
  }, [userId, apiClient, clearSavedTimer, setSaveState, setSaveError]);

  return { otpCode, otpExpiresAt, otpCountdown, resetOtp, handleGenerateOtp };
}
