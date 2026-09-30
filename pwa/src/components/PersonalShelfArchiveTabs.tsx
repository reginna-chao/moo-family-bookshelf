import type { ArchiveView } from "@/hooks/usePersonalShelfView";

export interface PersonalShelfArchiveTabsProps {
  archiveView: ArchiveView;
  activeCount: number;
  archivedCount: number;
  onSelectView: (view: ArchiveView) => void;
}

export function PersonalShelfArchiveTabs({
  archiveView,
  activeCount,
  archivedCount,
  onSelectView,
}: PersonalShelfArchiveTabsProps) {
  return (
    <div role="tablist" className="flex border-b border-gray-200 mb-3">
      <button
        role="tab"
        aria-selected={archiveView === "active"}
        onClick={() => {
          onSelectView("active");
        }}
        className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
          archiveView === "active"
            ? "border-blue-600 text-blue-600"
            : "border-transparent text-gray-500"
        }`}
      >
        未封存 ({activeCount})
      </button>
      <button
        role="tab"
        aria-selected={archiveView === "archived"}
        onClick={() => {
          onSelectView("archived");
        }}
        className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${
          archiveView === "archived"
            ? "border-blue-600 text-blue-600"
            : "border-transparent text-gray-500"
        }`}
      >
        封存 ({archivedCount})
      </button>
    </div>
  );
}
