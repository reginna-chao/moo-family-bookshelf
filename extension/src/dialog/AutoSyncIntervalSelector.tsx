import React from "react";
import type { AutoSyncInterval } from "./useAutoSyncInterval";
import { useIsMobile } from "../hooks/useIsMobile";

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
  const isMobile = useIsMobile();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as AutoSyncInterval)}
      aria-label="自動同步頻率"
      className={isMobile ? "moo-form-select moo-form-select--mobile" : "moo-form-select"}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
