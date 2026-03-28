interface FloatingActionBarProps {
  selectedCount: number;
  isDirty: boolean;
  isSaving: boolean;
  isSaved: boolean;
  onBatchShare: () => void;
  onBatchHide: () => void;
  onCancelChanges: () => void;
  onSave: () => void;
}

export function FloatingActionBar({
  selectedCount,
  isDirty,
  isSaving,
  isSaved,
  onBatchShare,
  onBatchHide,
  onCancelChanges,
  onSave,
}: FloatingActionBarProps) {
  const showSaveSection = isDirty || isSaving || isSaved;
  const visible = selectedCount > 0 || showSaveSection;
  if (!visible) return null;

  return (
    <div
      className="sticky bottom-0 bg-white border-t border-gray-200 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] px-4 py-2.5 flex items-center gap-2 flex-wrap"
      role="toolbar"
      aria-label="批次操作工具列"
    >
      {selectedCount > 0 && (
        <>
          <span className="text-sm text-gray-700 font-medium">
            已選 {selectedCount} 本
          </span>
          <button
            onClick={onBatchShare}
            className="px-3 py-1.5 text-xs font-medium rounded-full bg-blue-100 text-blue-700 hover:bg-blue-200"
          >
            設為開放
          </button>
          <button
            onClick={onBatchHide}
            className="px-3 py-1.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
          >
            設為隱藏
          </button>
        </>
      )}

      {selectedCount > 0 && showSaveSection && (
        <span className="mx-1 h-4 w-px bg-gray-300" aria-hidden="true" />
      )}

      {showSaveSection && (
        <>
          {isDirty && (
            <button
              onClick={onCancelChanges}
              className="px-3 py-1.5 text-xs font-medium rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              取消變更
            </button>
          )}
          <button
            onClick={onSave}
            disabled={isSaving || isSaved || !isDirty}
            className={`px-3 py-1.5 text-xs font-medium rounded-full ${
              isSaving
                ? "bg-blue-400 text-white cursor-not-allowed"
                : isSaved
                  ? "bg-green-100 text-green-700"
                  : !isDirty
                    ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {isSaving ? "儲存中..." : isSaved ? "已儲存" : "儲存變更"}
          </button>
        </>
      )}
    </div>
  );
}
