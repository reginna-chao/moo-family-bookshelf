import React from "react";
import { createRoot } from "react-dom/client";
import { App, type View } from "./App";
import {
  PortalContainerContext,
  type PortalContainer,
} from "./PortalContainerContext";
// Raw string: PostCSS/Tailwind never process it, and the bytes inline into content-dialog.js (no
// CSS asset to declare as a web-accessible resource).
import cssText from "./styles.css?raw";

interface MountDialogOptions {
  /** Called whenever the dialog's top-level view changes (loading/onboarding/main). */
  onViewChange?: (view: View) => void;
  /** Called with the incoming PENDING borrow count whenever it changes while mounted, so the host
   *  keeps the floating button's badge live (0 clears it). */
  onPendingBorrowCountChange?: (count: number) => void;
}

/** Marker attribute so we never inject the scoped stylesheet twice into a root. */
const STYLE_MARKER = "data-moo-dialog-styles";

/** Inject the scoped stylesheet into the container's shadow root (production) or `document.head`
 *  (dev page). Idempotent: a marked <style> makes a second mountDialog into the root a no-op. */
function injectScopedStyles(rootNode: Node): void {
  const styleParent: ShadowRoot | HTMLHeadElement =
    rootNode instanceof ShadowRoot ? rootNode : document.head;

  if (styleParent.querySelector(`style[${STYLE_MARKER}]`)) return;

  const style = document.createElement("style");
  style.setAttribute(STYLE_MARKER, "");
  style.textContent = cssText;
  styleParent.appendChild(style);
}

/**
 * Mount the Dialog React app into the given container element.
 * Used by the content script to inject the UI into the page.
 *
 * Returns an unmount handle: the caller MUST call it when tearing down the
 * dialog so the React root's effects/cleanups run and the root is released
 * (removing the host DOM alone leaks the root).
 */
export function mountDialog(
  container: HTMLElement,
  options?: MountDialogOptions,
): () => void {
  // The one "shadow root vs dev page" decision: the root node, computed once for both style
  // injection and the portal container.
  const rootNode = container.getRootNode();

  injectScopedStyles(rootNode);

  // Portal target for overlays (e.g. OverflowMenu): the ShadowRoot keeps fixed portals isolated
  // with the dialog; the dev page falls back to document.body.
  const portalContainer: PortalContainer =
    rootNode instanceof ShadowRoot ? rootNode : document.body;

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <PortalContainerContext.Provider value={portalContainer}>
        <App
          onViewChange={options?.onViewChange}
          onPendingBorrowCountChange={options?.onPendingBorrowCountChange}
        />
      </PortalContainerContext.Provider>
    </React.StrictMode>,
  );

  return () => root.unmount();
}

// Standalone mount for the dialog dev page (dialog/index.html)
const container = document.getElementById("root");
if (container) {
  mountDialog(container);
}
