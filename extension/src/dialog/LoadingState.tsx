import React from "react";

export interface LoadingStateProps {
  message: string;
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div
      data-testid="loading-state"
      role="status"
      className="moo-loading-state"
    >
      <div aria-hidden="true" className="moo-loading-state__spinner" />
      <p className="moo-loading-state__message">{message}</p>
    </div>
  );
}
