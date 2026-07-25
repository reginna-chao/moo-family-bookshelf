import React from "react";
import type { FloatingIconSize } from "./useFloatingIconSize";

export interface FloatingIconSizeSelectorProps {
  size: FloatingIconSize;
  onChange: (size: FloatingIconSize) => void;
}

type SegmentModifier = "first" | "middle" | "last";

interface SegmentProps {
  active: boolean;
  ariaLabel: string;
  label: string;
  onClick: () => void;
  position: SegmentModifier;
}

function Segment({
  active,
  ariaLabel,
  label,
  onClick,
  position,
}: SegmentProps) {
  const className = [
    "moo-segmented__item",
    `moo-segmented__item--${position}`,
    // The shared --active class is required: .moo-segmented__item's hover rule
    // excludes it, otherwise hover would override the active fill.
    active ? "moo-segmented__item--active" : "",
    "moo-icon-size__segment",
    active ? "moo-icon-size__segment--active" : "",
    `moo-icon-size__segment--${position}`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={className}
    >
      {label}
    </button>
  );
}

function getSegmentPosition(index: number, total: number): SegmentModifier {
  if (index === 0) return "first";
  if (index === total - 1) return "last";
  return "middle";
}

const OPTIONS: Array<{
  size: FloatingIconSize;
  label: string;
  ariaLabel: string;
}> = [
  { size: "icon", label: "圖示", ariaLabel: "僅圖示" },
  { size: "small", label: "小", ariaLabel: "小尺寸" },
  { size: "medium", label: "中", ariaLabel: "中尺寸" },
  { size: "large", label: "大", ariaLabel: "大尺寸" },
];

export function FloatingIconSizeSelector({
  size,
  onChange,
}: FloatingIconSizeSelectorProps) {
  return (
    <div role="group" aria-label="家庭書櫃按鈕大小" className="moo-icon-size">
      {OPTIONS.map((opt, index) => (
        <Segment
          key={opt.size}
          active={size === opt.size}
          ariaLabel={opt.ariaLabel}
          label={opt.label}
          onClick={() => onChange(opt.size)}
          position={getSegmentPosition(index, OPTIONS.length)}
        />
      ))}
    </div>
  );
}
