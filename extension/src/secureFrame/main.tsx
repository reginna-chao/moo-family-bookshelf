/** Entry of secure-frame.html: waits for the Dialog's handshake, then renders the requested
 *  view on the port it was handed. Never talks to `window.parent` directly. */
import { createRoot } from "react-dom/client";
import browser from "webextension-polyfill";
// Raw string, like the Dialog's own mount: no CSS asset to declare as a web-accessible resource.
import cssText from "../dialog/styles.css?raw";
import { EXT_ORIGIN, acceptHello, type ViewName } from "./protocol";
import { FrameApp } from "./FrameApp";

// styles.css pins font and colour on `:host`, which does not exist in a plain document.
const BASE_CSS = `html, body { margin: 0; background: transparent; }
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: var(--moo-text); line-height: normal; }`;

function injectStyles(): void {
  for (const text of [cssText, BASE_CSS]) {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.appendChild(style);
  }
}

function readNonce(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("n") ?? "";
}

/** Every `matches` entry of the manifest's web_accessible_resources, flattened. */
function readManifestMatches(): string[] {
  const entries: readonly unknown[] =
    browser.runtime.getManifest().web_accessible_resources ?? [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const matches: unknown = (entry as { matches?: unknown }).matches;
    if (!Array.isArray(matches)) return [];
    return matches.filter(
      (match): match is string => typeof match === "string",
    );
  });
}

function mountFrame(container: HTMLElement, view: ViewName, port: MessagePort) {
  const root = createRoot(container);
  root.render(<FrameApp view={view} port={port} />);
  window.addEventListener(
    "pagehide",
    () => {
      root.unmount();
      port.close();
    },
    { once: true },
  );
}

function start(): void {
  const container = document.getElementById("root");
  // Opened as a top-level page rather than framed by the Dialog: there is no host to wait for.
  if (!container || window.parent === window) return;
  injectStyles();

  const context = {
    expectedSource: window.parent,
    nonce: readNonce(),
    selfOrigin: EXT_ORIGIN,
    manifestMatches: readManifestMatches(),
  };
  const handleMessage = (event: MessageEvent) => {
    const hello = acceptHello(event, context);
    const port = event.ports[0];
    if (!hello || !port) return;
    window.removeEventListener("message", handleMessage);
    mountFrame(container, hello.view, port);
  };
  window.addEventListener("message", handleMessage);
}

start();
