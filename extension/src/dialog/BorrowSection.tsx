import React, { useState } from "react";
import { BorrowRequest } from "../api/client";
import { BorrowAction, BorrowRequestCard } from "./BorrowRequestCard";

export interface BorrowSectionProps {
  title: string;
  active: BorrowRequest[];
  archived: BorrowRequest[];
  renderActions: (request: BorrowRequest) => BorrowAction[];
  resolveOtherPartyName: (request: BorrowRequest) => string;
}

export function BorrowSection({
  title,
  active,
  archived,
  renderActions,
  resolveOtherPartyName,
}: BorrowSectionProps) {
  const [showArchived, setShowArchived] = useState(false);

  if (active.length === 0 && archived.length === 0) {
    return (
      <section style={{ marginBottom: 20 }}>
        <h4 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", margin: "0 0 8px 0" }}>
          {title}
        </h4>
        <p style={{ color: "#94a3b8", fontSize: 13, margin: 0 }}>尚無借閱請求</p>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: 20 }}>
      <h4 style={{ fontSize: 14, fontWeight: 600, color: "#1e293b", margin: "0 0 8px 0" }}>
        {title}
        <span style={{ color: "#94a3b8", fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
          ({active.length})
        </span>
      </h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {active.map((req) => (
          <BorrowRequestCard
            key={req.requestId}
            request={req}
            otherPartyName={resolveOtherPartyName(req)}
            actions={renderActions(req)}
          />
        ))}
      </div>
      {archived.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            style={{
              padding: 0,
              border: "none",
              background: "transparent",
              color: "#2563eb",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {showArchived ? "隱藏歷史紀錄" : `顯示歷史紀錄 (${archived.length})`}
          </button>
          {showArchived && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {archived.map((req) => (
                <BorrowRequestCard
                  key={req.requestId}
                  request={req}
                  otherPartyName={resolveOtherPartyName(req)}
                  actions={[]}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
