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
      <section className="moo-borrow-section">
        <h4 className="moo-borrow-section__title">{title}</h4>
        <p className="moo-borrow-section__empty">尚無借閱請求</p>
      </section>
    );
  }

  return (
    <section className="moo-borrow-section">
      <h4 className="moo-borrow-section__title">
        {title}
        <span className="moo-borrow-section__title-count">({active.length})</span>
      </h4>
      <div className="moo-borrow-section__list">
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
        <div className="moo-borrow-section__archived">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="moo-borrow-section__toggle"
          >
            {showArchived ? "隱藏歷史紀錄" : `顯示歷史紀錄 (${archived.length})`}
          </button>
          {showArchived && (
            <div className="moo-borrow-section__archived-list">
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
