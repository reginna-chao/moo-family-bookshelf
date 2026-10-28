import { useRef, useState } from "react";
import browser from "webextension-polyfill";
import { SECURE_FRAME_PATH, type ViewName, type ViewProps } from "./protocol";
import {
  outgoingProps,
  useSecureFrameChannel,
  type FrameHandlers,
} from "./useSecureFrameChannel";

export interface SecureFrameProps<V extends ViewName> extends FrameHandlers {
  view: V;
  props: ViewProps[V];
  /** The iframe's `title`: its accessible name for screen readers. */
  title: string;
  /** Iframe height until the frame reports its own content height. */
  placeholderHeight: number;
  /** Focus the entry view's field once the frame is ready. Off by default, like the fields it replaces. */
  autoFocus?: boolean;
  className?: string;
}

const NONCE_BYTES = 16;
const TAMPERED_TEXT = "畫面被干擾，請關閉後重新開啟";

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Renders `view` inside an extension-origin iframe, so the page around the Dialog can neither
 * read what it shows nor receive the keys typed into it. A view change mounts a fresh frame.
 */
export function SecureFrame<V extends ViewName>(props: SecureFrameProps<V>) {
  return <SecureFrameInstance key={props.view} {...props} />;
}

function SecureFrameInstance<V extends ViewName>({
  view,
  props,
  title,
  placeholderHeight,
  autoFocus = false,
  className,
  ...handlers
}: SecureFrameProps<V>) {
  const [nonce] = useState(makeNonce);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { tampered, height } = useSecureFrameChannel({
    iframeRef,
    nonce,
    view,
    props: outgoingProps(view, props, autoFocus),
    autoFocus,
    handlers,
  });

  if (tampered) {
    return (
      <div className="moo-secure-frame__tampered" role="alert">
        {TAMPERED_TEXT}
      </div>
    );
  }

  // Border, width and display live on .moo-secure-frame so a caller class can widen the frame.
  return (
    <iframe
      ref={iframeRef}
      title={title}
      src={`${browser.runtime.getURL(SECURE_FRAME_PATH)}#n=${nonce}`}
      className={
        className ? `moo-secure-frame ${className}` : "moo-secure-frame"
      }
      style={{ height: height ?? placeholderHeight }}
    />
  );
}
