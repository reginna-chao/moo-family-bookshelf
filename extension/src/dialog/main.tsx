import React from "react";
import { createRoot } from "react-dom/client";
import { App, type View } from "./App";

interface MountDialogOptions {
  /** Called whenever the dialog's top-level view changes (loading/onboarding/main). */
  onViewChange?: (view: View) => void;
}

/**
 * Mount the Dialog React app into the given container element.
 * Used by the content script to inject the UI into the page.
 */
export function mountDialog(
  container: HTMLElement,
  options?: MountDialogOptions,
): void {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App onViewChange={options?.onViewChange} />
    </React.StrictMode>,
  );
}

// Standalone mount for the dialog dev page (dialog/index.html)
const container = document.getElementById("root");
if (container) {
  mountDialog(container);
}
