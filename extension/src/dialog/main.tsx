import React from "react";
import { createRoot } from "react-dom/client";
import { App, type View } from "./App";
import { PortalContainerContext, type PortalContainer } from "./PortalContainerContext";
// Imported as a raw string so PostCSS/Tailwind never processes it; the exact
// bytes are inlined into content-dialog.js (no separate CSS asset to declare as
// a web-accessible resource).
import cssText from "./styles.css?raw";

interface MountDialogOptions {
  /** Called whenever the dialog's top-level view changes (loading/onboarding/main). */
  onViewChange?: (view: View) => void;
  /**
   * Called with the count of incoming PENDING borrow requests whenever it
   * changes while the dialog is mounted — lets the host keep the floating
   * button's badge live (including clearing it at 0).
   */
  onPendingBorrowCountChange?: (count: number) => void;
}

/** Marker attribute so we never inject the scoped stylesheet twice into a root. */
const STYLE_MARKER = "data-moo-dialog-styles";

/**
 * Inject the scoped stylesheet into the given root — the shadow root that owns
 * the container (production, isolated) or into `document.head` (standalone dev
 * page). Idempotent: a marked <style> is skipped so a second mountDialog into the
 * same root is a no-op.
 */
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
  // Single source of truth for the "shadow root vs dev page" decision: compute
  // the container's root node once and reuse it for both style injection and the
  // portal container.
  const rootNode = container.getRootNode();

  injectScopedStyles(rootNode);

  // Portal target for overlay UI (e.g. OverflowMenu). Inside the shadow root the
  // container's root node is the ShadowRoot itself, so fixed-positioned portals
  // stay isolated with the dialog; on the dev page it falls back to document.body.
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
