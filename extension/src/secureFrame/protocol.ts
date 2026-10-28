/** Dialog ↔ secure-frame protocol: one window-level `hello` hands over a MessagePort, all else uses
 *  the port; guards drop malformed messages. The feature's only `postMessage` calls live here. */
import browser from "webextension-polyfill";
import { isAllowedParentOrigin } from "./allowedOrigins";
import {
  isRecord,
  isSafeInteger,
  isString,
  isViewName,
  isViewProps,
  type ViewName,
  type ViewProps,
} from "./viewProps";

export type { ViewName, ViewProps } from "./viewProps";

/** Path of the iframe document; the same string is listed in the manifest's web_accessible_resources. */
export const SECURE_FRAME_PATH = "secure-frame.html";

/** The extension's own origin, built from protocol + host because `URL.origin` of a
 *  non-special scheme (`moz-extension:`) may serialise as "null". */
export const EXT_ORIGIN = (() => {
  const url = new URL(browser.runtime.getURL("/"));
  return `${url.protocol}//${url.host}`;
})();

export const HELLO_TYPE = "moo-secure-frame:hello";
export const MAX_FRAME_HEIGHT = 4000;

export interface HelloMessage {
  type: typeof HELLO_TYPE;
  nonce: string;
  view: ViewName;
}

export interface PropsMessage<V extends ViewName> {
  type: "props";
  view: V;
  props: ViewProps[V];
}

/** Discriminated on `view`, so a switch narrows `props` to that view's shape. */
export type AnyPropsMessage = { [V in ViewName]: PropsMessage<V> }[ViewName];

export type FrameToHostMessage =
  | { type: "ready" }
  | { type: "height"; px: number }
  | { type: "submit"; secret: string }
  | { type: "change"; value: string; seq: number }
  | { type: "paste" }
  | { type: "blur" };

/** Uniform signature of every view rendered inside the frame. */
export interface ViewComponentProps<V extends ViewName> {
  props: ViewProps[V];
  emit: (message: FrameToHostMessage) => void;
}

/** True for a `props` message addressed to `view` whose payload fits that view's shape. */
export function isPropsMessage(
  data: unknown,
  view: ViewName,
): data is AnyPropsMessage {
  return (
    isRecord(data) &&
    data.type === "props" &&
    data.view === view &&
    isViewProps(view, data.props)
  );
}

export function isFrameHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value < MAX_FRAME_HEIGHT
  );
}

export function isFrameToHostMessage(
  data: unknown,
): data is FrameToHostMessage {
  if (!isRecord(data)) return false;
  switch (data.type) {
    case "ready":
    case "paste":
    case "blur":
      return true;
    case "height":
      return isFrameHeight(data.px);
    case "submit":
      return isString(data.secret);
    case "change":
      return isString(data.value) && isSafeInteger(data.seq) && data.seq > 0;
    default:
      return false;
  }
}

export interface HelloEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface HelloContext {
  /** The only window allowed to send the hello — the frame's `window.parent`. */
  expectedSource: unknown;
  /** The `n` value of the frame's own URL hash; an empty nonce accepts nothing. */
  nonce: string;
  selfOrigin: string;
  manifestMatches: readonly string[];
}

/** Pure handshake check: the rebuilt hello when source, origin, schema and nonce all match, else null. */
export function acceptHello(
  event: HelloEvent,
  ctx: HelloContext,
): HelloMessage | null {
  if (event.source === null || event.source !== ctx.expectedSource) return null;
  if (
    !isAllowedParentOrigin(event.origin, ctx.manifestMatches, ctx.selfOrigin)
  ) {
    return null;
  }
  const data = event.data;
  if (!isRecord(data) || data.type !== HELLO_TYPE) return null;
  if (!isString(data.nonce) || !isViewName(data.view)) return null;
  if (ctx.nonce === "" || data.nonce !== ctx.nonce) return null;
  return { type: HELLO_TYPE, nonce: data.nonce, view: data.view };
}

/**
 * Host side, once per frame: hand `port` to the frame. The target origin is the extension's
 * own, never "*" — if the frame has been navigated elsewhere, the browser drops the message.
 */
export function sendHello(
  target: Window,
  nonce: string,
  view: ViewName,
  port: MessagePort,
): void {
  const hello: HelloMessage = { type: HELLO_TYPE, nonce, view };
  target.postMessage(hello, EXT_ORIGIN, [port]);
}

/** Send one protocol message over the handshake port (either direction). */
export function postToPort(
  port: MessagePort,
  message: PropsMessage<ViewName> | FrameToHostMessage,
): void {
  port.postMessage(message);
}
