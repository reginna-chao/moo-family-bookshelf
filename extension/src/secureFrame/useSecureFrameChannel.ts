import { useEffect, useRef, useState, type RefObject } from "react";
import {
  isFrameToHostMessage,
  postToPort,
  sendHello,
  type FrameToHostMessage,
  type ViewName,
  type ViewProps,
} from "./protocol";

export interface FrameHandlers {
  onSubmit?: (secret: string) => void;
  onChange?: (value: string) => void;
  onPaste?: () => void;
  onBlur?: () => void;
}

/** No `ready` this long after the frame is mounted (its first load may fire unobserved, or never):
 *  it never got the hello, so it is dropped like a reloaded one. One timer, no polling. */
export const READY_TIMEOUT_MS = 10_000;

// Display views never take focus; entry views only when the host asks (`autoFocus`).
const FOCUS_VIEWS: ReadonlySet<ViewName> = new Set<ViewName>([
  "pin",
  "pattern",
  "sync-code-input",
]);

/** The props sent to the frame: entry views carry the host's `autoFocus`, display views do not. */
export function outgoingProps<V extends ViewName>(
  view: V,
  props: ViewProps[V],
  autoFocus: boolean,
): ViewProps[V] {
  return FOCUS_VIEWS.has(view) ? { ...props, autoFocus } : props;
}

function dispatchToHandlers(
  message: FrameToHostMessage,
  handlers: FrameHandlers,
): void {
  switch (message.type) {
    case "submit":
      handlers.onSubmit?.(message.secret);
      return;
    case "change":
      handlers.onChange?.(message.value);
      return;
    case "paste":
      handlers.onPaste?.();
      return;
    case "blur":
      handlers.onBlur?.();
      return;
    default:
      return;
  }
}

export interface SecureFrameChannelOptions<V extends ViewName> {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  nonce: string;
  view: V;
  /** Already passed through `outgoingProps`. */
  props: ViewProps[V];
  autoFocus: boolean;
  handlers: FrameHandlers;
}

/**
 * Host side of the handshake: hello on the first load, props on `ready` and on every content
 * change, frame events to `handlers`. A second load or a missing `ready` sets `tampered`.
 */
export function useSecureFrameChannel<V extends ViewName>({
  iframeRef,
  nonce,
  view,
  props,
  autoFocus,
  handlers,
}: SecureFrameChannelOptions<V>) {
  const [tampered, setTampered] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const readyRef = useRef(false);
  const loadCountRef = useRef(0);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef<FrameHandlers>(handlers);
  const propsRef = useRef(props);
  const autoFocusRef = useRef(autoFocus);
  // Inline prop objects change identity every render; only a content change is re-sent.
  const serializedProps = JSON.stringify(props);

  useEffect(() => {
    handlersRef.current = handlers;
    propsRef.current = props;
    autoFocusRef.current = autoFocus;
  });

  // StrictMode-safe: the iframe is rendered by JSX; cleanup only closes the port, the timer and the listener.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const clearReadyTimer = () => {
      if (readyTimerRef.current !== null) clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    };
    const dropFrame = () => {
      clearReadyTimer();
      portRef.current?.close();
      portRef.current = null;
      setTampered(true);
    };
    // Runs from mount, not from the first `load`: a load missed by the listener still ends in the notice.
    readyTimerRef.current = setTimeout(dropFrame, READY_TIMEOUT_MS);
    const handleMessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isFrameToHostMessage(message)) return;
      if (message.type === "ready") {
        clearReadyTimer();
        readyRef.current = true;
        if (portRef.current) {
          postToPort(portRef.current, {
            type: "props",
            view,
            props: propsRef.current,
          });
        }
        if (autoFocusRef.current && FOCUS_VIEWS.has(view)) iframe.focus();
        return;
      }
      if (message.type === "height") {
        setHeight(message.px);
        return;
      }
      dispatchToHandlers(message, handlersRef.current);
    };
    const handleLoad = () => {
      loadCountRef.current += 1;
      // A second load means the frame was reloaded or navigated away: stop talking to it.
      if (loadCountRef.current > 1) {
        dropFrame();
        return;
      }
      const target = iframe.contentWindow;
      if (!target) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = handleMessage;
      portRef.current = channel.port1;
      sendHello(target, nonce, view, channel.port2);
    };

    iframe.addEventListener("load", handleLoad);
    return () => {
      iframe.removeEventListener("load", handleLoad);
      clearReadyTimer();
      portRef.current?.close();
      portRef.current = null;
      readyRef.current = false;
      loadCountRef.current = 0;
    };
  }, [iframeRef, nonce, view, tampered]);

  useEffect(() => {
    if (!readyRef.current || !portRef.current) return;
    postToPort(portRef.current, {
      type: "props",
      view,
      props: propsRef.current,
    });
  }, [serializedProps, view]);

  return { tampered, height };
}
