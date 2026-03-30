import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isExtensionContextValid } from "../utils/extensionContext";

function isContextInvalidatedError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("extension context invalidated") ||
    !isExtensionContextValid()
  );
}

function ContextInvalidatedFallback() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        textAlign: "center",
        minHeight: 160,
      }}
    >
      <p style={{ fontSize: 15, color: "#334155", marginBottom: 16, lineHeight: 1.6 }}>
        擴充功能已更新，請重新整理頁面以繼續使用。
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: "10px 24px",
          borderRadius: 8,
          border: "none",
          background: "#2563eb",
          color: "white",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        重新整理
      </button>
    </div>
  );
}

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
      if (isContextInvalidatedError(this.state.error)) {
        return <ContextInvalidatedFallback />;
      }
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
