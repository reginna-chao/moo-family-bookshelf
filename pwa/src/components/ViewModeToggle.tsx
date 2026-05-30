import React from "react";
import { LayoutGrid, Rows3 } from "lucide-react";

export type FamilyShelfViewMode = "grid" | "row";

export interface ViewModeToggleProps {
  mode: FamilyShelfViewMode;
  onChange: (mode: FamilyShelfViewMode) => void;
}

interface ToggleButtonProps {
  active: boolean;
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ToggleButton({ active, ariaLabel, onClick, children }: ToggleButtonProps) {
  const stateClasses = active
    ? "bg-blue-50 border-blue-600 text-blue-600"
    : "bg-white border-gray-300 text-gray-500";
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={`w-8 h-8 inline-flex items-center justify-center border ${stateClasses}`}
    >
      {children}
    </button>
  );
}

export function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="家庭書櫃顯示模式"
      className="inline-flex rounded-lg overflow-hidden"
    >
      <ToggleButton
        active={mode === "grid"}
        ariaLabel="切換為網格檢視"
        onClick={() => onChange("grid")}
      >
        <LayoutGrid size={18} />
      </ToggleButton>
      <ToggleButton
        active={mode === "row"}
        ariaLabel="切換為列表檢視"
        onClick={() => onChange("row")}
      >
        <Rows3 size={18} />
      </ToggleButton>
    </div>
  );
}
