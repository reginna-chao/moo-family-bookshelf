import { useCallback, useEffect, useState } from "react";
import {
  MAX_FRAME_HEIGHT,
  isPropsMessage,
  postToPort,
  type AnyPropsMessage,
  type FrameToHostMessage,
  type ViewName,
} from "./protocol";
import { PatternView, PinView } from "./views/SecretEntryView";
import { SyncCodeInputView } from "./views/SyncCodeInputView";
import { CredentialTextView, QrImageView } from "./views/DisplayViews";

export interface FrameAppProps {
  view: ViewName;
  /** The handshake port; every message in and out of the frame travels on it. */
  port: MessagePort;
}

type Emit = (message: FrameToHostMessage) => void;

function renderView(message: AnyPropsMessage, emit: Emit) {
  switch (message.view) {
    case "pin":
      return <PinView props={message.props} emit={emit} />;
    case "pattern":
      return <PatternView props={message.props} emit={emit} />;
    case "sync-code-input":
      return <SyncCodeInputView props={message.props} emit={emit} />;
    case "credential-text":
      return <CredentialTextView props={message.props} emit={emit} />;
    case "qr-image":
      return <QrImageView props={message.props} emit={emit} />;
    default:
      return null;
  }
}

/** Reports the document's height to the host whenever it changes, so the iframe fits its content. */
function useReportHeight(emit: Emit): void {
  useEffect(() => {
    const root = document.documentElement;
    const report = () => {
      const px = Math.ceil(root.getBoundingClientRect().height);
      if (px > 0 && px < MAX_FRAME_HEIGHT) emit({ type: "height", px });
    };
    const observer = new ResizeObserver(report);
    observer.observe(root);
    return () => observer.disconnect();
  }, [emit]);
}

/** Root of the iframe document: renders the handshake's view with the latest props from the host. */
export function FrameApp({ view, port }: FrameAppProps) {
  const [message, setMessage] = useState<AnyPropsMessage | null>(null);
  const emit = useCallback<Emit>((out) => postToPort(port, out), [port]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (isPropsMessage(data, view)) setMessage(data);
    };
    port.addEventListener("message", handleMessage);
    port.start();
    // Sent only once the listener is attached, so the host's first props cannot be missed.
    emit({ type: "ready" });
    return () => port.removeEventListener("message", handleMessage);
  }, [port, view, emit]);

  useReportHeight(emit);

  if (message === null) return null;
  return renderView(message, emit);
}
