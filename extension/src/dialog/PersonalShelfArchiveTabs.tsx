export type ArchiveView = "active" | "archived";

export interface PersonalShelfArchiveTabsProps {
  archiveView: ArchiveView;
  activeCount: number;
  archivedCount: number;
  onSelectView: (view: ArchiveView) => void;
}

function archiveTabClass(active: boolean): string {
  return active
    ? "moo-shelf__archive-tab moo-shelf__archive-tab--active"
    : "moo-shelf__archive-tab";
}

export function PersonalShelfArchiveTabs({
  archiveView,
  activeCount,
  archivedCount,
  onSelectView,
}: PersonalShelfArchiveTabsProps) {
  return (
    <div role="tablist" className="moo-shelf__archive-tabs">
      <button
        role="tab"
        aria-selected={archiveView === "active"}
        onClick={() => onSelectView("active")}
        className={archiveTabClass(archiveView === "active")}
      >
        未封存 ({activeCount})
      </button>
      <button
        role="tab"
        aria-selected={archiveView === "archived"}
        onClick={() => onSelectView("archived")}
        className={archiveTabClass(archiveView === "archived")}
      >
        封存 ({archivedCount})
      </button>
    </div>
  );
}
