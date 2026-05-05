import React from "react";

export interface LoadingStateProps {
  message: string;
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div
      data-testid="loading-state"
      role="status"
      style={{
        flex: 1,
        minHeight: 240,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 32,
          height: 32,
          border: "3px solid #e2e8f0",
          borderTopColor: "#2563eb",
          borderRadius: "50%",
          animation: "moo-spin 0.8s linear infinite",
        }}
      />
      <p style={{ color: "#64748b", fontSize: 14, margin: 0 }}>{message}</p>
      <style>{`
        @keyframes moo-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
