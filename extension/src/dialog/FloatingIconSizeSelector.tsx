import React from "react";
import type { FloatingIconSize } from "./useFloatingIconSize";

export interface FloatingIconSizeSelectorProps {
  size: FloatingIconSize;
  onChange: (size: FloatingIconSize) => void;
}

interface SegmentProps {
  active: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
}

function Segment({ active, ariaLabel, label, onClick }: SegmentProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "6px 0",
        border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
        background: active ? "#eff6ff" : "transparent",
        color: active ? "#2563eb" : "#64748b",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

const OPTIONS: Array<{ size: FloatingIconSize; label: string; ariaLabel: string }> = [
  { size: "icon", label: "圖示", ariaLabel: "僅圖示" },
  { size: "small", label: "小", ariaLabel: "小尺寸" },
  { size: "medium", label: "中", ariaLabel: "中尺寸" },
  { size: "large", label: "大", ariaLabel: "大尺寸" },
];

export function FloatingIconSizeSelector({ size, onChange }: FloatingIconSizeSelectorProps) {
  return (
    <div
      role="group"
      aria-label="家庭書櫃按鈕大小"
      style={{ display: "flex", borderRadius: 6, overflow: "hidden" }}
    >
      {OPTIONS.map((opt) => (
        <Segment
          key={opt.size}
          active={size === opt.size}
          ariaLabel={opt.ariaLabel}
          label={opt.label}
          onClick={() => onChange(opt.size)}
        />
      ))}
    </div>
  );
}
