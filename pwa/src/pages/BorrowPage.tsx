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
import { type BorrowAction } from "@/components/BorrowCard";
import { BorrowSectionView } from "@/components/BorrowSectionView";

export interface BorrowPageProps {
  userId: string;
  apiClient: ApiClient;
}

type Direction = "incoming" | "outgoing";

// Only PENDING requests stay in the active area. Once lent (LENT), a request
// moves to the history area — where its「標記已歸還」action is still available.
function isActive(request: BorrowRequest): boolean {
  return request.status === BorrowStatus.PENDING;
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

export function BorrowPage({ userId, apiClient }: BorrowPageProps) {
  const {
    borrowRequests,
    borrowRequestsState,
    borrowRequestsError,
    refreshBorrowRequests,
    applyBorrowStatus,
    members,
  } = useFamilyData();

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const { isDismissed, dismiss } = useManualLendNotice(userId);
  const [manualLendRequest, setManualLendRequest] =
    useState<BorrowRequest | null>(null);
  const [dontRemind, setDontRemind] = useState(false);

  const memberNameMap = useMemo(() => buildMemberNameMap(members), [members]);

  const updateStatus = useCallback(
    async (requestId: string, status: BorrowStatus) => {
      setActionError(null);
      setPendingRequestId(requestId);
      try {
        await apiClient.updateBorrowStatus(requestId, status);
        // Optimistic local update — the PATCH response already confirms success.
        // Re-fetching here would risk KV read-after-write returning stale data.
        applyBorrowStatus(requestId, status);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "更新失敗");
      } finally {
        setPendingRequestId(null);
      }
    },
    [apiClient, applyBorrowStatus],
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

  const closeManualLendDialog = useCallback(
    () => setManualLendRequest(null),
    [],
  );

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
