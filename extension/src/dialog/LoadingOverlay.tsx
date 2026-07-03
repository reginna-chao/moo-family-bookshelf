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
    <div data-testid="loading-overlay" className="moo-loading-overlay">
      <div className="moo-loading-overlay__spinner" />
      <p className="moo-loading-overlay__message">{message}</p>
    </div>
  );
}
