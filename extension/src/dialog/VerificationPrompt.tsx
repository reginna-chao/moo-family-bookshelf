import React from "react";
import type { VerifyMethod } from "../api/types";
import { PatternFrame, PinFrame } from "../secureFrame/frames";
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "./verificationMessages";
import { SubmittingOverlay } from "./VerificationSubmittingOverlay";

export interface VerificationPromptProps {
  /** null while the method is still being fetched from the backend. */
  method: VerifyMethod | null;
  /** True when the method failed to load for an active challenge. */
  methodError: boolean;
  error: string;
  locked: boolean;
  submitting: boolean;
  /** Remaining seconds of a rate-limit / lockout wait. null (or omitted) when
   *  the backend sent no `retryAfter` — the static copy is shown instead. */
  countdownSeconds?: number | null;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
}

const CODE_GUIDANCE =
  "此帳號使用一次性驗證碼。請在已登入的裝置或手機版（PWA）上完成驗證，" +
  "或改用 PIN／圖形驗證後再試一次。";

const METHOD_LOAD_ERROR = "無法載入驗證方式，請稍後再試";

/** Error message rendered as the entire challenge slot; --gap16 keeps it from
 *  butting against the 返回 button below. */
const MESSAGE_CHALLENGE_CLASS =
  "moo-secret-entry__error moo-secret-entry__error--gap16";

/**
 * Collects the PWA-login verification secret an existing member must supply when
 * reconnecting on a new device. Reused across all three onboarding join flows.
 * Renders PinInput / PatternLock by method, or guidance for OTP ("code").
 */
export function VerificationPrompt({
  method,
  methodError,
  error,
  locked,
  submitting,
  countdownSeconds = null,
  onSubmit,
  onCancel,
}: VerificationPromptProps): React.JSX.Element {
  // An unlocked countdown only ever runs for a rate-limited (429) wait, so
  // while one ticks it supersedes whatever static message is in state.
  const displayError =
    countdownSeconds === null ? error : rateLimitedMessage(countdownSeconds);
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">需要驗證</h2>
      <p className="moo-onboarding-view__body">
        為了保護你的書櫃資料，請完成登入驗證後再重新加入家庭。
      </p>
      {renderChallenge({
        method,
        methodError,
        error: displayError,
        locked,
        submitting,
        countdownSeconds,
        onSubmit,
      })}
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="moo-button moo-button--outline moo-button--block moo-onboarding-view__secondary"
      >
        返回
      </button>
    </div>
  );
}

interface ChallengeProps {
  method: VerifyMethod | null;
  methodError: boolean;
  error: string;
  locked: boolean;
  submitting: boolean;
  countdownSeconds: number | null;
  onSubmit: (secret: string) => void;
}

function renderChallenge({
  method,
  methodError,
  error,
  locked,
  submitting,
  countdownSeconds,
  onSubmit,
}: ChallengeProps): React.JSX.Element {
  if (locked) {
    return (
      <div className={MESSAGE_CHALLENGE_CLASS}>
        {verificationLockedMessage(countdownSeconds)}
      </div>
    );
  }
  if (methodError) {
    return <div className={MESSAGE_CHALLENGE_CLASS}>{METHOD_LOAD_ERROR}</div>;
  }
  if (method === null) {
    return <div className="moo-verify__loading">載入中...</div>;
  }
  // A ticking (unlocked) rate-limit countdown makes any submit a sure 429, so the widget stays inert
  // until the hook resets countdownSeconds to null, which re-enables it with no extra state.
  const inputDisabled = submitting || countdownSeconds !== null;
  // Every mount takes focus inside the frame: first show, after a lockout ends, after the view
  // switched away and back (docs/architecture.md → 浮動按鈕與 Dialog 外殼 →「焦點」).
  if (method === "pin") {
    return renderWidgetChallenge(
      <PinFrame
        autoFocus
        mode="verify"
        onComplete={onSubmit}
        error={error || undefined}
        disabled={inputDisabled}
      />,
      submitting,
    );
  }
  if (method === "pattern") {
    return renderWidgetChallenge(
      <PatternFrame
        autoFocus
        mode="verify"
        onComplete={onSubmit}
        error={error || undefined}
        disabled={inputDisabled}
      />,
      submitting,
    );
  }
  if (method === "code") {
    return renderCodeGuidance(submitting);
  }
  // method === "none": inconsistent for an active challenge — treat as a load
  // error rather than showing OTP guidance.
  return <div className={MESSAGE_CHALLENGE_CLASS}>{METHOD_LOAD_ERROR}</div>;
}

/** Wraps a PIN/pattern widget in a relatively-positioned box so the in-progress overlay can center
 *  over the dimmed, disabled widget while a submit is in flight. */
function renderWidgetChallenge(
  widget: React.JSX.Element,
  submitting: boolean,
): React.JSX.Element {
  return (
    <div style={{ position: "relative" }}>
      {widget}
      {submitting && <SubmittingOverlay />}
    </div>
  );
}

function renderCodeGuidance(submitting: boolean): React.JSX.Element {
  return (
    <div className="moo-verify__none-warning">
      <div className="moo-verify__none-box">
        <div className="moo-verify__none-text">{CODE_GUIDANCE}</div>
      </div>
      {submitting && (
        <div className="moo-verify__status moo-verify__status--saving">
          驗證中...
        </div>
      )}
    </div>
  );
}
