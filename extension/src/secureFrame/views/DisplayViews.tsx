import type { ViewComponentProps } from "../protocol";

/** `credential-text` view: a sync code or OTP, keeping the caller's test id and classes. */
export function CredentialTextView({
  props,
}: ViewComponentProps<"credential-text">) {
  return (
    <span data-testid={props.testId} className={props.className}>
      {props.text}
    </span>
  );
}

/** `qr-image` view: the QR data URL drawn by the content script, not selectable or draggable. */
export function QrImageView({ props }: ViewComponentProps<"qr-image">) {
  return (
    <div className="moo-secure-frame__qr">
      <img
        src={props.dataUrl}
        alt={props.alt}
        width={props.size}
        height={props.size}
        draggable={false}
      />
    </div>
  );
}
