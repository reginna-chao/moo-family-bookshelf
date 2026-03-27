import React from "react";

export interface LoadingOverlayProps {
  message: string;
}

/**
 * Full-screen semi-transparent overlay with centered progress text.
 * Covers the Dialog content during the automated onboarding flow.
 */
export function LoadingOverlay({ message }: LoadingOverlayProps) {
  return (
    <div
      data-testid="loading-overlay"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        background: "rgba(255, 255, 255, 0.92)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          border: "3px solid #e2e8f0",
          borderTopColor: "#2563eb",
          borderRadius: "50%",
          animation: "moo-spin 0.8s linear infinite",
          marginBottom: 16,
        }}
      />
      <p
        style={{
          color: "#334155",
          fontSize: 15,
          fontWeight: 600,
          textAlign: "center",
        }}
      >
        {message}
      </p>
      <style>{`
        @keyframes moo-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
