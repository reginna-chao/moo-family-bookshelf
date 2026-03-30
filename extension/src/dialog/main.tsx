import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

class DialogErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[MooFamily] React render error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return <div style={{ padding: 16, color: "red" }}>Error: {this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

/**
 * Mount the Dialog React app into the given container element.
 * Used by the content script to inject the UI into the page.
 */
export function mountDialog(container: HTMLElement): void {
  try {
    const root = createRoot(container);
    root.render(
      <React.StrictMode>
        <DialogErrorBoundary>
          <App />
        </DialogErrorBoundary>
      </React.StrictMode>,
    );
    console.log("[MooFamily] React root created and render called");
  } catch (err) {
    console.error("[MooFamily] createRoot/render failed:", err);
    container.textContent = "渲染失敗";
  }
}

// Standalone mount for the dialog dev page (dialog/index.html)
const container = document.getElementById("root");
if (container) {
  mountDialog(container);
}
