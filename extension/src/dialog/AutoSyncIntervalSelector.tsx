import React from "react";
import type { AutoSyncInterval } from "./useAutoSyncInterval";

export interface AutoSyncIntervalSelectorProps {
  value: AutoSyncInterval;
  onChange: (interval: AutoSyncInterval) => void;
}

const OPTIONS: Array<{ value: AutoSyncInterval; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每 7 天" },
  { value: "monthly", label: "每 30 天" },
  { value: "never", label: "永不" },
];

export function AutoSyncIntervalSelector({ value, onChange }: AutoSyncIntervalSelectorProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AutoSyncInterval)}
      aria-label="自動同步頻率"
      className="moo-form-select"
      style={{
        padding: "8px 12px",
        paddingRight: "2.25rem",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        backgroundColor: "white",
        fontSize: 14,
        color: "#334155",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
