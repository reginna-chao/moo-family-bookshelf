import React from "react";
import { Loader2 } from "lucide-react";
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
      {renderChallenge({
        method,
        methodError,
        error,
        locked,
        submitting,
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
    return (
      <div className="moo-secret-entry__error">驗證已鎖定，請稍後再試</div>
    );
  }
  if (methodError) {
    return <div className="moo-secret-entry__error">{METHOD_LOAD_ERROR}</div>;
  }
  if (method === null) {
    return <div className="moo-verify__loading">載入中...</div>;
  }
  if (method === "pin") {
    return renderWidgetChallenge(
      <PinInput
        mode="verify"
        onComplete={onSubmit}
        error={error || undefined}
        disabled={submitting}
      />,
      submitting,
    );
  }
  if (method === "pattern") {
    return renderWidgetChallenge(
      <PatternLock
        mode="verify"
        onComplete={onSubmit}
        error={error || undefined}
        disabled={submitting}
      />,
      submitting,
    );
  }
  if (method === "code") {
    return renderCodeGuidance(submitting);
  }
  // method === "none": inconsistent for an active challenge — treat as a load
  // error rather than showing OTP guidance.
  return <div className="moo-secret-entry__error">{METHOD_LOAD_ERROR}</div>;
}

/**
 * Wraps a PIN/pattern widget in a relatively-positioned container so an
 * in-progress overlay can be centered over the (dimmed, disabled) widget while
 * a verification submit is in flight.
 */
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

/** Centered spinner + "驗證中..." shown over the challenge widget during submit. */
function SubmittingOverlay(): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        // Subtle white backdrop keeps the text readable over the dimmed grid.
        backgroundColor: "rgba(255, 255, 255, 0.6)",
        borderRadius: 8,
        // Widget is already disabled; never intercept pointer events.
        pointerEvents: "none",
      }}
    >
      <Loader2
        aria-hidden="true"
        size={28}
        className="moo-spin"
        style={{ color: "#64748b" }}
      />
      <span style={{ fontSize: 14, color: "#475569" }}>驗證中...</span>
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
