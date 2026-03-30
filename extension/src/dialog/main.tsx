import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/**
 * Mount the Dialog React app into the given container element.
 * Used by the content script to inject the UI into the page.
 */
export function mountDialog(container: HTMLElement): void {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Standalone mount for the dialog dev page (dialog/index.html)
const container = document.getElementById("root");
if (container) {
  mountDialog(container);
}
