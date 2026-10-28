/** The views the secure frame can render and the runtime shape check of each view's props.
 *  Split from protocol.ts (which re-exports the types) to keep both files under the line cap. */
import type { PinInputProps } from "../dialog/PinInput";
import type { PatternLockProps } from "../dialog/PatternLock";

/** Carried by the entry views only: focus the field on the first props (default off). */
interface FocusProps {
  autoFocus?: boolean;
}

export interface ViewProps {
  pin: Omit<PinInputProps, "onComplete"> & FocusProps;
  pattern: Omit<PatternLockProps, "onComplete"> & FocusProps;
  "sync-code-input": FocusProps & {
    value: string;
    disabled: boolean;
    masked: boolean;
    placeholder: string;
    ariaLabel: string;
    /** Extra classes appended to the input's own (e.g. room for a reveal button). */
    className?: string;
    /** Seq of the last `change` the host applied; 0 before it has applied any. */
    appliedSeq: number;
  };
  "credential-text": { text: string; testId: string; className?: string };
  "qr-image": { dataUrl: string; alt: string; size: number };
}

export type ViewName = keyof ViewProps;

const QR_DATA_URL_PREFIX = "data:image/png;base64,";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || isBoolean(value);
}

function isSecretEntryProps(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.mode === "setup" || value.mode === "verify") &&
    isOptionalString(value.error) &&
    isOptionalBoolean(value.disabled) &&
    isOptionalBoolean(value.autoFocus)
  );
}

function isSyncCodeInputProps(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.value) &&
    isBoolean(value.disabled) &&
    isBoolean(value.masked) &&
    isString(value.placeholder) &&
    isString(value.ariaLabel) &&
    isOptionalString(value.className) &&
    isOptionalBoolean(value.autoFocus) &&
    isSafeInteger(value.appliedSeq) &&
    value.appliedSeq >= 0
  );
}

function isCredentialTextProps(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.text) &&
    isString(value.testId) &&
    isOptionalString(value.className)
  );
}

function isQrImageProps(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.dataUrl) &&
    value.dataUrl.startsWith(QR_DATA_URL_PREFIX) &&
    isString(value.alt) &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    value.size > 0
  );
}

const PROPS_GUARDS: Readonly<Record<ViewName, (value: unknown) => boolean>> = {
  pin: isSecretEntryProps,
  pattern: isSecretEntryProps,
  "sync-code-input": isSyncCodeInputProps,
  "credential-text": isCredentialTextProps,
  "qr-image": isQrImageProps,
};

export function isViewName(value: unknown): value is ViewName {
  return isString(value) && Object.hasOwn(PROPS_GUARDS, value);
}

/** True when `value` fits the props shape of `view`. */
export function isViewProps<V extends ViewName>(
  view: V,
  value: unknown,
): value is ViewProps[V] {
  return PROPS_GUARDS[view](value);
}
