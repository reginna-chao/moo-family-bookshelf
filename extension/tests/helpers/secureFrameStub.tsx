import type {
  FrameToHostMessage,
  ViewName,
  ViewProps,
} from "../../src/secureFrame/protocol";
import type { SecureFrameProps } from "../../src/secureFrame/SecureFrame";
import { outgoingProps } from "../../src/secureFrame/useSecureFrameChannel";
import {
  PatternView,
  PinView,
} from "../../src/secureFrame/views/SecretEntryView";
import { SyncCodeInputView } from "../../src/secureFrame/views/SyncCodeInputView";
import {
  CredentialTextView,
  QrImageView,
} from "../../src/secureFrame/views/DisplayViews";

type Emit = (message: FrameToHostMessage) => void;

function renderInline<V extends ViewName>(
  view: V,
  props: ViewProps[V],
  emit: Emit,
) {
  // Narrowing a generic `V` needs the casts; the view name and props were paired by the caller.
  switch (view) {
    case "pin":
      return <PinView props={props as ViewProps["pin"]} emit={emit} />;
    case "pattern":
      return <PatternView props={props as ViewProps["pattern"]} emit={emit} />;
    case "sync-code-input":
      return (
        <SyncCodeInputView
          props={props as ViewProps["sync-code-input"]}
          emit={emit}
        />
      );
    case "credential-text":
      return (
        <CredentialTextView
          props={props as ViewProps["credential-text"]}
          emit={emit}
        />
      );
    case "qr-image":
      return <QrImageView props={props as ViewProps["qr-image"]} emit={emit} />;
    default:
      return null;
  }
}

/**
 * jsdom stand-in for `SecureFrame` (installed by `extension/tests/setup.ts` with `vi.mock`): jsdom
 * never loads `secure-frame.html`, so the requested view renders inline in the host's DOM and its
 * `emit` is wired straight to the host's `onSubmit` / `onChange` / `onPaste` / `onBlur` (`height`
 * is ignored). The props go through the real `outgoingProps`, so entry views get `autoFocus`
 * exactly as the frame would. `key={view}` mirrors the real component's remount on view change.
 * `tests/component/SecureFrame.test.tsx` and `FrameApp.test.tsx` test the real handshake instead.
 */
export function SecureFrameStub<V extends ViewName>({
  view,
  props,
  autoFocus = false,
  onSubmit,
  onChange,
  onPaste,
  onBlur,
}: SecureFrameProps<V>) {
  const emit: Emit = (message) => {
    switch (message.type) {
      case "submit":
        onSubmit?.(message.secret);
        return;
      case "change":
        onChange?.(message.value, message.seq);
        return;
      case "paste":
        onPaste?.();
        return;
      case "blur":
        onBlur?.();
        return;
      default:
        return;
    }
  };
  return (
    <div key={view} data-secure-frame-stub={view}>
      {renderInline(view, outgoingProps(view, props, autoFocus), emit)}
    </div>
  );
}
