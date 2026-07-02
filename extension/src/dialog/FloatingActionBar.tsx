import React from "react";

export interface FloatingActionBarProps {
  selectedCount: number;
  isDirty: boolean;
  isSaving: boolean;
  isSaved: boolean;
  onBatchShare: () => void;
  onBatchHide: () => void;
  onCancel: () => void;
  onSave: () => void;
}

export function FloatingActionBar({
  selectedCount,
  isDirty,
  isSaving,
  isSaved,
  onBatchShare,
  onBatchHide,
  onCancel,
  onSave,
}: FloatingActionBarProps) {
  const hasSelection = selectedCount > 0;
  if (!hasSelection && !isDirty) return null;

  const saveLabel = isSaving ? "儲存中..." : isSaved ? "已儲存" : "儲存變更";
  const saveDisabled = !isDirty || isSaving;

  const cancelClass = hasSelection
    ? "moo-action-bar__cancel moo-action-bar__cancel--pushed"
    : "moo-action-bar__cancel";
  const saveClass = hasSelection ? "moo-action-bar__save" : "moo-action-bar__save moo-action-bar__save--grow";

  return (
    <div className="moo-action-bar">
      {hasSelection && (
        <>
          <span className="moo-action-bar__count">已選 {selectedCount} 本</span>
          <button onClick={onBatchShare} className="moo-action-bar__btn moo-action-bar__btn--share">
            設為開放
          </button>
          <button onClick={onBatchHide} className="moo-action-bar__btn moo-action-bar__btn--hide">
            設為隱藏
          </button>
        </>
      )}
      {isDirty && (
        <button onClick={onCancel} disabled={isSaving} className={cancelClass}>
          取消變更
        </button>
      )}
      {isDirty && (
        <button onClick={onSave} disabled={saveDisabled} className={saveClass}>
          {saveLabel}
        </button>
      )}
    </div>
  );
}
