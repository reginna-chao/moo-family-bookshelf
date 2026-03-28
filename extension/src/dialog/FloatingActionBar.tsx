import React from "react";

export interface FloatingActionBarProps {
  selectedCount: number;
  isDirty: boolean;
  isSaving: boolean;
  isSaved: boolean;
  onBatchShare: () => void;
  onBatchHide: () => void;
  onSave: () => void;
}

export function FloatingActionBar({
  selectedCount,
  isDirty,
  isSaving,
  isSaved,
  onBatchShare,
  onBatchHide,
  onSave,
}: FloatingActionBarProps) {
  const hasSelection = selectedCount > 0;
  if (!hasSelection && !isDirty) return null;

  const saveLabel = isSaving ? "儲存中..." : isSaved ? "已儲存" : "儲存變更";
  const saveDisabled = !isDirty || isSaving;

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        background: "#ffffff",
        borderTop: "1px solid #e2e8f0",
        boxShadow: "0 -2px 8px rgba(0,0,0,0.06)",
        borderRadius: "0 0 8px 8px",
        flexWrap: "wrap",
      }}
    >
      {hasSelection && (
        <>
          <span style={{ fontSize: 13, color: "#475569", fontWeight: 500 }}>
            已選 {selectedCount} 本
          </span>
          <button
            onClick={onBatchShare}
            style={{
              padding: "6px 14px",
              border: "none",
              borderRadius: 6,
              background: "#16a34a",
              color: "white",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            設為開放
          </button>
          <button
            onClick={onBatchHide}
            style={{
              padding: "6px 14px",
              border: "none",
              borderRadius: 6,
              background: "#64748b",
              color: "white",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            設為隱藏
          </button>
        </>
      )}
      {isDirty && (
        <button
          onClick={onSave}
          disabled={saveDisabled}
          style={{
            marginLeft: hasSelection ? "auto" : 0,
            padding: "6px 14px",
            border: "none",
            borderRadius: 6,
            background: saveDisabled ? "#e2e8f0" : "#2563eb",
            color: saveDisabled ? "#94a3b8" : "white",
            fontWeight: 600,
            fontSize: 13,
            cursor: saveDisabled ? "not-allowed" : "pointer",
            flex: hasSelection ? undefined : 1,
          }}
        >
          {saveLabel}
        </button>
      )}
    </div>
  );
}
