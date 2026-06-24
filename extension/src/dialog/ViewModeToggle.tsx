import React from "react";
import { LayoutGrid, Rows3 } from "lucide-react";
import type { FamilyShelfViewMode } from "./useFamilyShelfViewMode";
import { useIsMobile } from "../hooks/useIsMobile";

export interface ViewModeToggleProps {
  mode: FamilyShelfViewMode;
  onChange: (mode: FamilyShelfViewMode) => void;
}

interface ToggleButtonProps {
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  size: number;
  position?: "first" | "middle" | "last";
}

function getBorderRadius(position?: "first" | "middle" | "last"): string {
  if (position === "first") return "6px 0 0 6px";
  if (position === "last") return "0 6px 6px 0";
  return "0";
}

function ToggleButton({ active, ariaLabel, onClick, children, size, position }: ToggleButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: active ? "1px solid #2563eb" : "1px solid #e2e8f0",
        borderRadius: getBorderRadius(position),
        background: active ? "#eff6ff" : "transparent",
        color: active ? "#2563eb" : "#64748b",
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  const isMobile = useIsMobile();
  const size = isMobile ? 32 : 40;
  return (
    <div
      role="group"
      aria-label="家庭書櫃顯示模式"
      style={{ display: "inline-flex", borderRadius: 6, overflow: "hidden" }}
    >
      <ToggleButton
        active={mode === "grid"}
        ariaLabel="切換為網格檢視"
        onClick={() => onChange("grid")}
        size={size}
        position="first"
      >
        <LayoutGrid size={18} />
      </ToggleButton>
      <ToggleButton
        active={mode === "row"}
        ariaLabel="切換為列表檢視"
        onClick={() => onChange("row")}
        size={size}
        position="last"
      >
        <Rows3 size={18} />
      </ToggleButton>
    </div>
  );
}
