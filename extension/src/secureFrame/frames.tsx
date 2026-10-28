/** One preset per secret-bearing element of the Dialog, so each frame's title, view and
 *  placeholder height are defined once. Every Dialog call site goes through these. */
import { useState } from "react";
import type { PinInputProps } from "../dialog/PinInput";
import type { PatternLockProps } from "../dialog/PatternLock";
import { SecureFrame } from "./SecureFrame";

const PIN_HEIGHT = 120;
const PATTERN_HEIGHT = 264;
// The 40px field plus the 4px focus-ring room on each side (.moo-secure-frame__field).
const SYNC_CODE_INPUT_HEIGHT = 48;
const CREDENTIAL_TEXT_HEIGHT = 32;
const SYNC_CODE_TITLE = "家庭同步碼";

/** PinInput, same props, rendered inside the secure frame. */
export function PinFrame({ onComplete, ...props }: PinInputProps) {
  return (
    <SecureFrame
      view="pin"
      title="PIN 輸入"
      props={props}
      placeholderHeight={PIN_HEIGHT}
      onSubmit={onComplete}
    />
  );
}

/** PatternLock, same props, rendered inside the secure frame. */
export function PatternFrame({ onComplete, ...props }: PatternLockProps) {
  return (
    <SecureFrame
      view="pattern"
      title="圖形驗證"
      props={props}
      placeholderHeight={PATTERN_HEIGHT}
      onSubmit={onComplete}
    />
  );
}

export interface SyncCodeInputFrameProps {
  value: string;
  disabled: boolean;
  masked: boolean;
  /** Extra classes for the input inside the frame (after moo-form-input moo-form-input--block). */
  inputClassName: string;
  onChange: (value: string) => void;
  onPaste: () => void;
  onBlur: () => void;
}

/** The join-family sync-code field. The frame bleeds 4px past its box so the focus ring is not cut. */
export function SyncCodeInputFrame({
  value,
  disabled,
  masked,
  inputClassName,
  onChange,
  ...handlers
}: SyncCodeInputFrameProps) {
  // Echoed back in the props so the field can tell a stale echo from a host value (#422).
  const [appliedSeq, setAppliedSeq] = useState(0);
  return (
    <SecureFrame
      view="sync-code-input"
      title={SYNC_CODE_TITLE}
      props={{
        value,
        disabled,
        masked,
        placeholder: "輸入家庭同步碼",
        ariaLabel: SYNC_CODE_TITLE,
        className: inputClassName,
        appliedSeq,
      }}
      placeholderHeight={SYNC_CODE_INPUT_HEIGHT}
      className="moo-secure-frame--bleed"
      onChange={(next, seq) => {
        setAppliedSeq(seq);
        onChange(next);
      }}
      {...handlers}
    />
  );
}

export interface SyncCodeTextFrameProps {
  syncCode: string;
  /** Class of the text inside the frame (keeps the box's monospace look). */
  textClassName: string;
}

/** A family sync code on display; the text keeps `data-testid="sync-code"`. */
export function SyncCodeTextFrame({
  syncCode,
  textClassName,
}: SyncCodeTextFrameProps) {
  return (
    <SecureFrame
      view="credential-text"
      title={SYNC_CODE_TITLE}
      props={{ text: syncCode, testId: "sync-code", className: textClassName }}
      placeholderHeight={CREDENTIAL_TEXT_HEIGHT}
    />
  );
}

export interface OtpCodeFrameProps {
  code: string;
}

/** The one-time login code on display; the text keeps `data-testid="otp-code"`. */
export function OtpCodeFrame({ code }: OtpCodeFrameProps) {
  return (
    <SecureFrame
      view="credential-text"
      title="驗證碼"
      props={{
        text: code,
        testId: "otp-code",
        className: "moo-verify__otp-code",
      }}
      placeholderHeight={CREDENTIAL_TEXT_HEIGHT}
    />
  );
}

export interface QrImageFrameProps {
  dataUrl: string;
  alt: string;
  size: number;
}

/** A QR Code data URL drawn by the content script, shown at `size` px square. */
export function QrImageFrame({ dataUrl, alt, size }: QrImageFrameProps) {
  return (
    <SecureFrame
      view="qr-image"
      title="QR Code"
      props={{ dataUrl, alt, size }}
      placeholderHeight={size}
    />
  );
}
