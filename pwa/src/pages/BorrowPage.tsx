import { useCallback, useMemo, useState } from "react";
import {
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
  type FamilyMember,
} from "@/api/client";
import { useFamilyData } from "@/hooks/useFamilyData";
import { useManualLendNotice } from "@/hooks/useManualLendNotice";
import { ManualLendDialog } from "@/components/ManualLendDialog";

export interface BorrowPageProps {
  userId: string;
  apiClient: ApiClient;
}

interface StatusStyle {
  label: string;
  className: string;
}

function getStatusStyle(status: BorrowStatus): StatusStyle {
  switch (status) {
    case BorrowStatus.PENDING:
      return { label: "待處理", className: "bg-blue-100 text-blue-700" };
    case BorrowStatus.LENT:
      return { label: "出借中", className: "bg-green-100 text-green-700" };
    case BorrowStatus.RETURNED:
      return { label: "已歸還", className: "bg-gray-200 text-gray-600" };
    case BorrowStatus.REJECTED:
      return { label: "已拒絕", className: "bg-red-100 text-red-700" };
    case BorrowStatus.CANCELLED:
      return { label: "已取消", className: "bg-gray-200 text-gray-500" };
  }
}

type Direction = "incoming" | "outgoing";

interface BorrowAction {
  label: string;
  onClick: () => void;
  variant: "primary" | "danger" | "secondary";
  disabled?: boolean;
}

function isActive(request: BorrowRequest): boolean {
  return (
    request.status === BorrowStatus.PENDING ||
    request.status === BorrowStatus.LENT
  );
}

function sortNewestFirst(a: BorrowRequest, b: BorrowRequest): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function buildMemberNameMap(members: FamilyMember[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of members) {
    map.set(m.userId, m.displayName || m.userId.slice(0, 8));
  }
  return map;
}

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

function actionClassName(variant: BorrowAction["variant"]): string {
  const base =
    "px-3 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  if (variant === "primary") {
    return `${base} bg-blue-600 text-white border-blue-600 hover:bg-blue-700`;
  }
  if (variant === "danger") {
    return `${base} bg-transparent text-red-600 border-red-600 hover:bg-red-50`;
  }
  return `${base} bg-transparent text-slate-600 border-slate-300 hover:bg-slate-50`;
}

interface BorrowCardProps {
  request: BorrowRequest;
  otherPartyName: string;
  actions: BorrowAction[];
}

function BorrowCard({ request, otherPartyName, actions }: BorrowCardProps) {
  const status = getStatusStyle(request.status);
  return (
    <div className="flex gap-3 p-3 bg-white border border-gray-200 rounded-lg">
      {request.bookCoverUrl ? (
        <img
          src={request.bookCoverUrl}
          alt={request.bookTitle}
          className="w-10 h-[60px] object-cover rounded bg-gray-100 flex-shrink-0"
        />
      ) : (
        <div className="w-10 h-[60px] rounded bg-gray-100 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="text-sm font-semibold text-gray-900 leading-tight truncate">
          {request.bookTitle}
        </div>
        {request.bookAuthor && (
          <div className="text-xs text-gray-400 truncate">
            {request.bookAuthor}
          </div>
        )}
        <div className="text-xs text-gray-600 truncate">
          對象：<span className="font-semibold">{otherPartyName}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${status.className}`}
          >
            {status.label}
          </span>
          <span className="text-[11px] text-gray-400">
            {formatRelativeTime(request.createdAt)}
          </span>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                className={actionClassName(action.variant)}
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

interface BorrowSectionProps {
  title: string;
  active: BorrowRequest[];
  archived: BorrowRequest[];
  renderActions: (request: BorrowRequest) => BorrowAction[];
  resolveOtherPartyName: (request: BorrowRequest) => string;
}

function BorrowSectionView({
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

export function BorrowPage({ userId, apiClient }: BorrowPageProps) {
  const {
    borrowRequests,
    borrowRequestsState,
    borrowRequestsError,
    refreshBorrowRequests,
    members,
  } = useFamilyData();

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const { isDismissed, dismiss } = useManualLendNotice(userId);
  const [manualLendRequest, setManualLendRequest] =
    useState<BorrowRequest | null>(null);
  const [dontRemind, setDontRemind] = useState(false);

  const memberNameMap = useMemo(
    () => buildMemberNameMap(members),
    [members],
  );

  const updateStatus = useCallback(
    async (requestId: string, status: BorrowStatus) => {
      setActionError(null);
      setPendingRequestId(requestId);
      try {
        await apiClient.updateBorrowStatus(requestId, status);
        await refreshBorrowRequests();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "更新失敗");
      } finally {
        setPendingRequestId(null);
      }
    },
    [apiClient, refreshBorrowRequests],
  );

  const handleManualLend = useCallback(
    (request: BorrowRequest) => {
      if (isDismissed) {
        void updateStatus(request.requestId, BorrowStatus.LENT);
        return;
      }
      setManualLendRequest(request);
      setDontRemind(false);
    },
    [isDismissed, updateStatus],
  );

  const handleConfirmManualLend = useCallback(async () => {
    if (!manualLendRequest) return;
    if (dontRemind) {
      dismiss();
    }
    await updateStatus(manualLendRequest.requestId, BorrowStatus.LENT);
    setManualLendRequest(null);
  }, [manualLendRequest, dontRemind, dismiss, updateStatus]);

  const closeManualLendDialog = useCallback(() => setManualLendRequest(null), []);

  const confirmManualLend = useCallback(() => {
    void handleConfirmManualLend();
  }, [handleConfirmManualLend]);

  const buckets = useMemo(() => {
    const incomingActive: BorrowRequest[] = [];
    const incomingArchived: BorrowRequest[] = [];
    const outgoingActive: BorrowRequest[] = [];
    const outgoingArchived: BorrowRequest[] = [];

    for (const r of borrowRequests) {
      if (r.ownerId === userId) {
        (isActive(r) ? incomingActive : incomingArchived).push(r);
      } else if (r.borrowerId === userId) {
        (isActive(r) ? outgoingActive : outgoingArchived).push(r);
      }
    }

    incomingActive.sort(sortNewestFirst);
    incomingArchived.sort(sortNewestFirst);
    outgoingActive.sort(sortNewestFirst);
    outgoingArchived.sort(sortNewestFirst);

    return {
      incoming: { active: incomingActive, archived: incomingArchived },
      outgoing: { active: outgoingActive, archived: outgoingArchived },
    };
  }, [borrowRequests, userId]);

  const buildActions = useCallback(
    (request: BorrowRequest, direction: Direction): BorrowAction[] => {
      const isUpdating = pendingRequestId === request.requestId;
      if (request.status === BorrowStatus.PENDING) {
        if (direction === "incoming") {
          return [
            {
              label: isUpdating ? "處理中..." : "手動借出",
              variant: "primary",
              disabled: isUpdating,
              onClick: () => handleManualLend(request),
            },
            {
              label: "拒絕",
              variant: "danger",
              disabled: isUpdating,
              onClick: () =>
                void updateStatus(request.requestId, BorrowStatus.REJECTED),
            },
          ];
        }
        return [
          {
            label: isUpdating ? "處理中..." : "取消申請",
            variant: "secondary",
            disabled: isUpdating,
            onClick: () =>
              void updateStatus(request.requestId, BorrowStatus.CANCELLED),
          },
        ];
      }
      if (request.status === BorrowStatus.LENT) {
        return [
          {
            label: isUpdating ? "處理中..." : "標記已歸還",
            variant: "secondary",
            disabled: isUpdating,
            onClick: () =>
              void updateStatus(request.requestId, BorrowStatus.RETURNED),
          },
        ];
      }
      return [];
    },
    [handleManualLend, pendingRequestId, updateStatus],
  );

  const resolveIncomingOtherParty = useCallback(
    (req: BorrowRequest) =>
      req.borrowerName ||
      memberNameMap.get(req.borrowerId) ||
      req.borrowerId.slice(0, 8),
    [memberNameMap],
  );

  const resolveOutgoingOtherParty = useCallback(
    (req: BorrowRequest) =>
      memberNameMap.get(req.ownerId) ?? req.ownerId.slice(0, 8),
    [memberNameMap],
  );

  if (borrowRequestsState === "idle" || borrowRequestsState === "loading") {
    return (
      <div className="p-4 text-center" role="status" aria-label="載入中">
        <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
        <p className="text-gray-500 text-sm mt-3">載入借閱資料中...</p>
      </div>
    );
  }

  if (borrowRequestsState === "error") {
    return (
      <div className="p-4">
        <p className="text-red-500 text-sm mb-3">
          {borrowRequestsError ?? "載入失敗"}
        </p>
        <button
          onClick={() => void refreshBorrowRequests()}
          className="px-4 py-2 text-sm font-semibold text-blue-600 border border-blue-600 rounded-lg"
        >
          重試
        </button>
      </div>
    );
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">借閱管理</h2>
      {actionError && (
        <div
          role="alert"
          className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700"
        >
          {actionError}
        </div>
      )}
      <BorrowSectionView
        title="收件匣"
        active={buckets.incoming.active}
        archived={buckets.incoming.archived}
        renderActions={(req) => buildActions(req, "incoming")}
        resolveOtherPartyName={resolveIncomingOtherParty}
      />
      <BorrowSectionView
        title="寄件匣"
        active={buckets.outgoing.active}
        archived={buckets.outgoing.archived}
        renderActions={(req) => buildActions(req, "outgoing")}
        resolveOtherPartyName={resolveOutgoingOtherParty}
      />
      {manualLendRequest && (
        <ManualLendDialog
          dontRemindChecked={dontRemind}
          onDontRemindChange={setDontRemind}
          onConfirm={confirmManualLend}
          onCancel={closeManualLendDialog}
          confirming={pendingRequestId === manualLendRequest.requestId}
        />
      )}
    </div>
  );
}
