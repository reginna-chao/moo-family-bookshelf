import { useState } from "react";
import type { ApiClient } from "@/api/client";
import {
  FloatingActionBar,
  shouldShowFloatingBar,
} from "@/components/FloatingActionBar";
import { PublicShareDialog } from "@/components/PublicShareDialog";
import {
  PersonalShelfLoading,
  PersonalShelfError,
  PersonalShelfEmpty,
} from "@/components/PersonalShelfStatus";
import { PersonalShelfHeader } from "@/components/PersonalShelfHeader";
import { PersonalShelfArchiveTabs } from "@/components/PersonalShelfArchiveTabs";
import { PersonalShelfFilterBar } from "@/components/PersonalShelfFilterBar";
import { PersonalShelfSearchBar } from "@/components/PersonalShelfSearchBar";
import { PersonalShelfBookList } from "@/components/PersonalShelfBookList";
import { useBookSort } from "@/hooks/useBookSort";
import { usePersonalShelfEditor } from "@/hooks/usePersonalShelfEditor";
import { usePersonalShelfView } from "@/hooks/usePersonalShelfView";

interface PersonalShelfPageProps {
  userId: string;
  apiClient: ApiClient;
  /** Items shown per page in the personal shelf list. Injectable for tests; production uses the default. */
  pageSize?: number;
}

export function PersonalShelfPage({
  userId,
  apiClient,
  pageSize,
}: PersonalShelfPageProps) {
  const [showPublicShare, setShowPublicShare] = useState(false);
  // Called before the editor so its effect keeps running ahead of the
  // editor's timer-cleanup and load effects, as when this was one component.
  const { sort, setSort } = useBookSort(userId, "personal");
  const {
    books,
    displayName,
    state,
    errorMessage,
    dirtyBookIds,
    isDirty,
    selectedIds,
    setSelectedIds,
    loadBooks,
    handleSave,
    handleCancelChanges,
    handleBatchShare,
    handleBatchHide,
    handleToggle,
    toggleSelect,
  } = usePersonalShelfEditor(userId, apiClient);
  const view = usePersonalShelfView({
    userId,
    books,
    sort,
    pageSize,
    selectedIds,
    setSelectedIds,
  });

  const showFloatingBar = shouldShowFloatingBar({
    selectedCount: selectedIds.size,
    isDirty,
    isSaving: state === "saving",
    isSaved: state === "saved",
  });

  if (state === "loading") {
    return <PersonalShelfLoading />;
  }

  if (state === "error") {
    return <PersonalShelfError message={errorMessage} onRetry={loadBooks} />;
  }

  if (books.length === 0) {
    return <PersonalShelfEmpty />;
  }

  return (
    <div className="flex flex-col min-h-0">
      <div
        data-testid="personal-shelf-list-container"
        className={`p-4 flex-1 ${showFloatingBar ? "pb-[var(--personal-shelf-bottom-clearance)]" : ""}`}
      >
        <PersonalShelfHeader
          bookCount={view.currentViewBooks.length}
          onOpenPublicShare={() => setShowPublicShare(true)}
        />

        {view.showArchiveTabs && (
          <PersonalShelfArchiveTabs
            archiveView={view.archiveView}
            activeCount={view.activeBooks.length}
            archivedCount={view.archivedBooks.length}
            onSelectView={view.selectArchiveView}
          />
        )}

        <PersonalShelfFilterBar
          statusFilter={view.statusFilter}
          onStatusFilterChange={view.selectStatusFilter}
          sort={sort}
          onSortChange={setSort}
        />

        <PersonalShelfSearchBar
          searchTerm={view.searchTerm}
          onSearchTermChange={view.setSearchTerm}
          categoryBooks={view.statusFilteredBooks}
          categoryFilter={view.categoryFilter}
          onCategoryFilterChange={view.setCategoryFilter}
        />

        <PersonalShelfBookList
          visibleBooks={view.visibleBooks}
          isFiltering={view.isFiltering}
          allVisibleSelected={view.allVisibleSelected}
          onSelectAll={view.handleSelectAll}
          selectedIds={selectedIds}
          dirtyBookIds={dirtyBookIds}
          onSelect={toggleSelect}
          onToggle={handleToggle}
          hasMore={view.hasMore}
          onLoadMore={view.loadMore}
          totalFilteredBookCount={view.filteredItems.length}
        />
      </div>

      <FloatingActionBar
        selectedCount={selectedIds.size}
        isDirty={isDirty}
        isSaving={state === "saving"}
        isSaved={state === "saved"}
        onBatchShare={handleBatchShare}
        onBatchHide={handleBatchHide}
        onCancelChanges={handleCancelChanges}
        onSave={() => void handleSave()}
      />

      {showPublicShare && (
        <PublicShareDialog
          userId={userId}
          apiClient={apiClient}
          defaultDisplayName={displayName || "我"}
          onClose={() => setShowPublicShare(false)}
        />
      )}
    </div>
  );
}
