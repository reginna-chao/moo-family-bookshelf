import React from "react";
import { BorrowRequest, BorrowStatus } from "../api/client";

export type BorrowActionVariant = "primary" | "danger" | "secondary";

export interface BorrowAction {
  label: string;
  onClick: () => void;
  variant?: BorrowActionVariant;
  disabled?: boolean;
}

export interface BorrowRequestCardProps {
  request: BorrowRequest;
  /** borrowerName for incoming, owner displayName for outgoing. */
  otherPartyName: string;
  actions: BorrowAction[];
}

const STATUS_STYLE: Record<
  BorrowStatus,
  { label: string; background: string; color: string }
> = {
  [BorrowStatus.PENDING]: {
    label: "待處理",
    background: "#dbeafe",
    color: "#1d4ed8",
  },
  [BorrowStatus.LENT]: {
    label: "出借中",
    background: "#dcfce7",
    color: "#15803d",
  },
  [BorrowStatus.RETURNED]: {
    label: "已歸還",
    background: "#e2e8f0",
    color: "#475569",
  },
  [BorrowStatus.REJECTED]: {
    label: "已拒絕",
    background: "#fee2e2",
    color: "#b91c1c",
  },
  [BorrowStatus.CANCELLED]: {
    label: "已取消",
    background: "#e2e8f0",
    color: "#64748b",
  },
};

/** Human-friendly relative time in 繁體中文 (falls back to ISO date on parse error). */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "剛剛";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

function actionStyle(variant: BorrowActionVariant = "secondary"): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid",
    background: "transparent",
  };
  if (variant === "primary") {
    return { ...base, background: "#2563eb", color: "white", borderColor: "#2563eb" };
  }
  if (variant === "danger") {
    return { ...base, color: "#dc2626", borderColor: "#dc2626" };
  }
  return { ...base, color: "#475569", borderColor: "#cbd5e1" };
}

export function BorrowRequestCard({
  request,
  otherPartyName,
  actions,
}: BorrowRequestCardProps) {
  const statusStyle = STATUS_STYLE[request.status];

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: 12,
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        background: "white",
        alignItems: "flex-start",
      }}
    >
      <img
        src={request.bookCoverUrl}
        alt={request.bookTitle}
        style={{
          width: 48,
          height: 72,
          objectFit: "cover",
          borderRadius: 4,
          background: "#f1f5f9",
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b", lineHeight: 1.3 }}>
          {request.bookTitle}
        </div>
        {request.bookAuthor && (
          <div style={{ fontSize: 12, color: "#94a3b8" }}>{request.bookAuthor}</div>
        )}
        <div style={{ fontSize: 12, color: "#475569" }}>
          對象：<span style={{ fontWeight: 600 }}>{otherPartyName}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 10,
              background: statusStyle.background,
              color: statusStyle.color,
            }}
          >
            {statusStyle.label}
          </span>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>
            {formatRelativeTime(request.createdAt)}
          </span>
        </div>
        {actions.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                style={{
                  ...actionStyle(action.variant),
                  opacity: action.disabled ? 0.5 : 1,
                  cursor: action.disabled ? "not-allowed" : "pointer",
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
