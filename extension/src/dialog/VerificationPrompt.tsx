import React from "react";
import type { VerifyMethod } from "../api/types";
import { PinInput } from "./PinInput";
import { PatternLock } from "./PatternLock";

export interface VerificationPromptProps {
  /** null while the method is still being fetched from the backend. */
  method: VerifyMethod | null;
  /** True when the method failed to load for an active challenge. */
  methodError: boolean;
  error: string;
  locked: boolean;
  submitting: boolean;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
}

const CODE_GUIDANCE =
  "此帳號使用一次性驗證碼。請在已登入的裝置或手機版（PWA）上完成驗證，" +
  "或改用 PIN／圖形驗證後再試一次。";

const METHOD_LOAD_ERROR = "無法載入驗證方式，請稍後再試";

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
  onSubmit,
  onCancel,
}: VerificationPromptProps): React.JSX.Element {
  return (
    <div className="moo-onboarding-view">
      <h2 className="moo-onboarding-view__heading">需要驗證</h2>
      <p className="moo-onboarding-view__body">
        為了保護你的書櫃資料，請完成登入驗證後再重新加入家庭。
      </p>
      {renderChallenge({ method, methodError, error, locked, submitting, onSubmit })}
      {submitting && method !== "code" && method !== "none" && (
        <div className="moo-verify__status moo-verify__status--saving">驗證中...</div>
      )}
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="moo-onboarding-view__secondary"
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
  onSubmit: (secret: string) => void;
}

function renderChallenge({
  method,
  methodError,
  error,
  locked,
  submitting,
  onSubmit,
}: ChallengeProps): React.JSX.Element {
  if (locked) {
    return <div className="moo-secret-entry__error">驗證已鎖定，請稍後再試</div>;
  }
  if (methodError) {
    return <div className="moo-secret-entry__error">{METHOD_LOAD_ERROR}</div>;
  }
  if (method === null) {
    return <div className="moo-verify__loading">載入中...</div>;
  }
  if (method === "pin") {
    return <PinInput mode="verify" onComplete={onSubmit} error={error || undefined} />;
  }
  if (method === "pattern") {
    return <PatternLock mode="verify" onComplete={onSubmit} error={error || undefined} />;
  }
  if (method === "code") {
    return renderCodeGuidance(submitting);
  }
  // method === "none": inconsistent for an active challenge — treat as a load
  // error rather than showing OTP guidance.
  return <div className="moo-secret-entry__error">{METHOD_LOAD_ERROR}</div>;
}

function renderCodeGuidance(submitting: boolean): React.JSX.Element {
  return (
    <div className="moo-verify__none-warning">
      <div className="moo-verify__none-box">
        <div className="moo-verify__none-text">{CODE_GUIDANCE}</div>
      </div>
      {submitting && (
        <div className="moo-verify__status moo-verify__status--saving">驗證中...</div>
      )}
    </div>
  );
}
