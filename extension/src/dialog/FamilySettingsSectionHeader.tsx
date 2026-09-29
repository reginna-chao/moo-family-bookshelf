import { ChevronDown, ChevronRight } from "lucide-react";

function sectionHeaderClass(open: boolean): string {
  return open
    ? "moo-settings__section-header moo-settings__section-header--open"
    : "moo-settings__section-header";
}

export interface FamilySettingsSectionHeaderProps {
  open: boolean;
  onToggle: () => void;
  label: string;
}

/** Collapsible section header shared by the three FamilySettings sections. */
export function FamilySettingsSectionHeader({
  open,
  onToggle,
  label,
}: FamilySettingsSectionHeaderProps) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={sectionHeaderClass(open)}
    >
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      {label}
    </button>
  );
}
