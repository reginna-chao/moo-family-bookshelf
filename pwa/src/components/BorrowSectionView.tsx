import { useState } from "react";
import { type BorrowRequest } from "@/api/client";
import { BorrowCard, type BorrowAction } from "@/components/BorrowCard";

export interface BorrowSectionProps {
  title: string;
  active: BorrowRequest[];
  archived: BorrowRequest[];
  renderActions: (request: BorrowRequest) => BorrowAction[];
  resolveOtherPartyName: (request: BorrowRequest) => string;
}

export function BorrowSectionView({
  title,
  active,
  archived,
  renderActions,
  resolveOtherPartyName,
}: BorrowSectionProps) {
  const [showArchived, setShowArchived] = useState(false);

  if (active.length === 0 && archived.length === 0) {
    return (
      <section className="mb-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-400">尚無借閱請求</p>
      </section>
    );
  }

  return (
    <section className="mb-5">
      <h3 className="text-sm font-semibold text-gray-900 mb-2">
        {title}
        <span className="ml-1.5 text-xs font-normal text-gray-400">
          ({active.length})
        </span>
      </h3>
      <div className="flex flex-col gap-2">
        {active.map((req) => (
          <BorrowCard
            key={req.requestId}
            request={req}
            otherPartyName={resolveOtherPartyName(req)}
            actions={renderActions(req)}
          />
        ))}
      </div>
      {archived.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-xs font-semibold text-blue-600 hover:text-blue-700"
          >
            {showArchived
              ? "隱藏歷史紀錄"
              : `顯示歷史紀錄 (${archived.length})`}
          </button>
          {showArchived && (
            <div className="flex flex-col gap-2 mt-2">
              {archived.map((req) => (
                <BorrowCard
                  key={req.requestId}
                  request={req}
                  otherPartyName={resolveOtherPartyName(req)}
                  actions={renderActions(req)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
