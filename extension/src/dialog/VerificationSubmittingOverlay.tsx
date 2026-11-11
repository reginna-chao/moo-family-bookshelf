import React from "react";
import { Loader2 } from "lucide-react";

/** Centered spinner + "驗證中..." shown over the challenge widget during submit. */
export function SubmittingOverlay(): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        // Subtle white backdrop keeps the text readable over the dimmed grid.
        backgroundColor: "rgba(255, 255, 255, 0.6)",
        borderRadius: 8,
        // Widget is already disabled; never intercept pointer events.
        pointerEvents: "none",
      }}
    >
      <Loader2
        aria-hidden="true"
        size={28}
        className="moo-spin"
        style={{ color: "#64748b" }}
      />
      <span style={{ fontSize: 14, color: "#475569" }}>驗證中...</span>
    </div>
  );
}
