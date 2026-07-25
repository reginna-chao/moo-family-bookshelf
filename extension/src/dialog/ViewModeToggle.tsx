import React from "react";
import { LayoutGrid, Rows3 } from "lucide-react";
import type { FamilyShelfViewMode } from "./useFamilyShelfViewMode";
import { useIsMobile } from "../hooks/useIsMobile";

type SegmentPosition = "first" | "middle" | "last";

export interface ViewModeToggleProps {
  mode: FamilyShelfViewMode;
  onChange: (mode: FamilyShelfViewMode) => void;
}

interface ToggleButtonProps {
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  isMobile: boolean;
  position: Extract<SegmentPosition, "first" | "last">;
}

function ToggleButton({
  active,
  ariaLabel,
  onClick,
  children,
  isMobile,
  position,
}: ToggleButtonProps) {
  const className = [
    "moo-segmented__item",
    `moo-segmented__item--${position}`,
    // The shared --active class is required: .moo-segmented__item's hover rule
    // excludes it, otherwise hover would override the active fill.
    active ? "moo-segmented__item--active" : "",
    "moo-view-toggle__btn",
    isMobile ? "moo-view-toggle__btn--mobile" : "",
    active ? "moo-view-toggle__btn--active" : "",
    `moo-view-toggle__btn--${position}`,
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
      {children}
    </button>
  );
}

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  const isMobile = useIsMobile();
  return (
    <div role="group" aria-label="家庭書櫃顯示模式" className="moo-view-toggle">
      <ToggleButton
        active={mode === "grid"}
        ariaLabel="切換為網格檢視"
        onClick={() => onChange("grid")}
        isMobile={isMobile}
        position="first"
      >
        <LayoutGrid size={18} />
      </ToggleButton>
      <ToggleButton
        active={mode === "row"}
        ariaLabel="切換為列表檢視"
        onClick={() => onChange("row")}
        isMobile={isMobile}
        position="last"
      >
        <Rows3 size={18} />
      </ToggleButton>
    </div>
  );
}
