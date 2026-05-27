import React, { useCallback, useMemo, useState } from "react";
import {
  ApiClient,
  BorrowRequest,
  BorrowStatus,
  FamilyMember,
} from "../api/client";
import { useFamilyData } from "./FamilyDataContext";
import { BorrowAction } from "./BorrowRequestCard";
import { BorrowSection } from "./BorrowSection";
import {
  ReadmooLendError,
  ReadmooMember,
  closeLendDialog,
  decideLendAction,
  openLendDialogForBook,
  selectMemberByName,
  waitForLendDialogClose,
} from "../content/readmoo-lend";
import { ReadmooMemberPicker } from "./ReadmooMemberPicker";

export interface BorrowTabProps {
  userId: string;
  apiClient: ApiClient;
}

const ACTIVE_STATUSES = new Set<BorrowStatus>([
  BorrowStatus.PENDING,
  BorrowStatus.LENT,
]);

function isActive(request: BorrowRequest): boolean {
  return ACTIVE_STATUSES.has(request.status);
}

function sortNewestFirst(a: BorrowRequest, b: BorrowRequest): number {
  return b.createdAt.localeCompare(a.createdAt);
}

function buildOwnerNameLookup(members: FamilyMember[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of members) {
    map.set(m.userId, m.displayName || m.userId.slice(0, 8));
  }
  return map;
}

/**
 * Local state for the "請選擇對應的讀墨家庭成員" picker. Held in BorrowTab
 * (instead of inside readmoo-lend) so React owns the UI lifecycle and we can
 * await the user's choice with a Promise resolver pattern.
 */
interface PickerState {
  request: BorrowRequest;
  lendDialog: HTMLElement;
  options: ReadmooMember[];
  saving: boolean;
  errorMessage: string | null;
  /** Resolved with the picked member (success) or `null` (user cancelled). */
  resolve: (picked: ReadmooMember | null) => void;
}

export function BorrowTab({ userId, apiClient }: BorrowTabProps) {
  const {
    borrowRequests,
    borrowRequestsState,
    borrowRequestsError,
    refreshBorrowRequests,
    members,
    familyId,
    updateMember,
  } = useFamilyData();

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);

  const ownerNameLookup = useMemo(() => buildOwnerNameLookup(members), [members]);

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

  /**
   * Show the readmoo member picker and wait for the user to either pick a
   * member or cancel. The PATCH and Readmoo dialog dismissal are owned by
   * `handleApproveLending` — the picker only collects the user's choice.
   */
  const requestPick = useCallback(
    (
      request: BorrowRequest,
      lendDialog: HTMLElement,
      options: ReadmooMember[],
    ): Promise<ReadmooMember | null> => {
      return new Promise((resolve) => {
        setPicker({
          request,
          lendDialog,
          options,
          saving: false,
          errorMessage: null,
          resolve,
        });
      });
    },
    [],
  );

  /**
   * Approve an incoming PENDING request: drive Readmoo's native lending
   * flow via Content Script, then mark the MooFamily request as LENT
   * once the Readmoo dialog closes (signals the user accepted the
   * native confirm).
   *
   * When n ≥ 2 and readmooName is missing / does not match, surface the
   * picker; on confirm we PATCH readmooName before clicking the option.
   */
  const handleApproveLending = useCallback(
    async (request: BorrowRequest) => {
      setActionError(null);
      setPendingRequestId(request.requestId);
      try {
        const borrower = members.find((m) => m.userId === request.borrowerId);
        const readmooName = borrower?.readmooName;

        const { lendDialog, members: readmooMembers } =
          await openLendDialogForBook(request.bookId);
        const decision = decideLendAction(readmooMembers, readmooName);

        let target: ReadmooMember | undefined = decision.target;
        if (decision.mode === "needs-pick") {
          const picked = await requestPick(request, lendDialog, readmooMembers);
          if (!picked) {
            // User cancelled — closeLendDialog was already called in onCancel.
            return;
          }
          target = picked;
        }

        if (!target) {
          throw new ReadmooLendError(
            "MEMBER_NOT_FOUND",
            "找不到要點擊的讀墨成員選項",
          );
        }
        const clicked = selectMemberByName(lendDialog, target.name);
        if (!clicked) {
          throw new ReadmooLendError(
            "MEMBER_NOT_FOUND",
            `在讀墨借出書籍清單中找不到「${target.name}」`,
          );
        }
        const closed = await waitForLendDialogClose(lendDialog);
        if (!closed) {
          throw new ReadmooLendError(
            "CONFIRM_TIMEOUT",
            "讀墨借出對話框未關閉，請重新嘗試",
          );
        }
        await apiClient.updateBorrowStatus(request.requestId, BorrowStatus.LENT);
        await refreshBorrowRequests();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "借出失敗";
        setActionError(`自動借出失敗：${msg}`);
      } finally {
        setPendingRequestId(null);
      }
    },
    [apiClient, members, refreshBorrowRequests, requestPick],
  );

  const handlePickerPick = useCallback(
    async (member: ReadmooMember) => {
      if (!picker) return;
      const { request, resolve } = picker;
      setPicker((prev) =>
        prev ? { ...prev, saving: true, errorMessage: null } : prev,
      );
      try {
        const updated = await apiClient.updateMemberSettings(
          familyId,
          request.borrowerId,
          { readmooName: member.name },
        );
        updateMember(updated);
        setPicker(null);
        resolve(member);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "儲存失敗";
        setPicker((prev) =>
          prev ? { ...prev, saving: false, errorMessage: msg } : prev,
        );
      }
    },
    [picker, apiClient, familyId, updateMember],
  );

  const handlePickerCancel = useCallback(() => {
    if (!picker || picker.saving) return;
    closeLendDialog(picker.lendDialog);
    const resolve = picker.resolve;
    setPicker(null);
    resolve(null);
  }, [picker]);

  const { incoming, outgoing } = useMemo(() => {
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

  const renderIncomingActions = useCallback(
    (request: BorrowRequest): BorrowAction[] => {
      const isUpdating = pendingRequestId === request.requestId;
      if (request.status === BorrowStatus.PENDING) {
        return [
          {
            label: isUpdating ? "處理中..." : "同意借閱",
            variant: "primary",
            disabled: isUpdating,
            onClick: () => handleApproveLending(request),
          },
          {
            label: "拒絕",
            variant: "danger",
            disabled: isUpdating,
            onClick: () => void updateStatus(request.requestId, BorrowStatus.REJECTED),
          },
        ];
      }
      if (request.status === BorrowStatus.LENT) {
        return [
          {
            label: isUpdating ? "處理中..." : "標記已歸還",
            variant: "secondary",
            disabled: isUpdating,
            onClick: () => void updateStatus(request.requestId, BorrowStatus.RETURNED),
          },
        ];
      }
      return [];
    },
    [handleApproveLending, pendingRequestId, updateStatus],
  );

  const renderOutgoingActions = useCallback(
    (request: BorrowRequest): BorrowAction[] => {
      const isUpdating = pendingRequestId === request.requestId;
      if (request.status === BorrowStatus.PENDING) {
        return [
          {
            label: isUpdating ? "處理中..." : "取消申請",
            variant: "secondary",
            disabled: isUpdating,
            onClick: () => void updateStatus(request.requestId, BorrowStatus.CANCELLED),
          },
        ];
      }
      if (request.status === BorrowStatus.LENT) {
        return [
          {
            label: isUpdating ? "處理中..." : "標記已歸還",
            variant: "secondary",
            disabled: isUpdating,
            onClick: () => void updateStatus(request.requestId, BorrowStatus.RETURNED),
          },
        ];
      }
      return [];
    },
    [pendingRequestId, updateStatus],
  );

  const resolveIncomingOtherParty = useCallback(
    (req: BorrowRequest) =>
      req.borrowerName || ownerNameLookup.get(req.borrowerId) || req.borrowerId.slice(0, 8),
    [ownerNameLookup],
  );

  const resolveOutgoingOtherParty = useCallback(
    (req: BorrowRequest) => ownerNameLookup.get(req.ownerId) ?? req.ownerId.slice(0, 8),
    [ownerNameLookup],
  );

  if (borrowRequestsState === "idle" || borrowRequestsState === "loading") {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "#64748b" }}>
        載入借閱資料中...
      </div>
    );
  }

  if (borrowRequestsState === "error") {
    return (
      <div style={{ padding: 16 }}>
        <p style={{ color: "#ef4444", fontSize: 14, marginBottom: 12 }}>
          {borrowRequestsError ?? "載入失敗"}
        </p>
        <button
          onClick={() => void refreshBorrowRequests()}
          style={{
            padding: "8px 16px",
            border: "1px solid #2563eb",
            borderRadius: 8,
            background: "transparent",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          重試
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>借閱管理</h3>
      {actionError && (
        <div
          role="alert"
          style={{
            padding: 8,
            marginBottom: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            color: "#b91c1c",
            fontSize: 13,
          }}
        >
          {actionError}
        </div>
      )}
      <BorrowSection
        title="收件匣"
        active={incoming.active}
        archived={incoming.archived}
        renderActions={renderIncomingActions}
        resolveOtherPartyName={resolveIncomingOtherParty}
      />
      <BorrowSection
        title="寄件匣"
        active={outgoing.active}
        archived={outgoing.archived}
        renderActions={renderOutgoingActions}
        resolveOtherPartyName={resolveOutgoingOtherParty}
      />
      {picker && (
        <ReadmooMemberPicker
          borrowerName={picker.request.borrowerName || picker.request.borrowerId.slice(0, 8)}
          options={picker.options}
          saving={picker.saving}
          errorMessage={picker.errorMessage}
          onPick={(member) => void handlePickerPick(member)}
          onCancel={handlePickerCancel}
        />
      )}
    </div>
  );
}
