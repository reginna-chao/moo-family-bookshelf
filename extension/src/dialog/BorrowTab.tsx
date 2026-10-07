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
  BORROW_HISTORY_HINT_INCOMING,
  BORROW_HISTORY_HINT_OUTGOING,
} from "moo-family-bookshelf-shared/borrow/history";
import {
  ReadmooLendError,
  ReadmooMember,
  closeLendDialog,
  decideLendAction,
  dismissOpenDialogs,
  openLendDialogForBook,
  restoreLibrarySearch,
  selectMemberByName,
  waitForLendDialogClose,
} from "../content/readmoo-lend";
import { ReadmooMemberPicker } from "./ReadmooMemberPicker";
import { ManualLendDialog } from "./ManualLendDialog";
import { memberSettingsErrorMessage } from "./memberSettingsMessages";
import { useManualLendNotice } from "./useManualLendNotice";

export interface BorrowTabProps {
  userId: string;
  apiClient: ApiClient;
}

// Only PENDING requests stay in the active area. Once lent (LENT), a request
// moves to the history area — where its「標記已歸還」action is still available.
const ACTIVE_STATUSES = new Set<BorrowStatus>([BorrowStatus.PENDING]);

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

/** State of the "請選擇對應的讀墨家庭成員" picker, held here (not in readmoo-lend) so React owns
 *  its lifecycle and the user's choice can be awaited through a Promise resolver. */
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
    applyBorrowStatus,
    members,
    familyId,
    updateMember,
  } = useFamilyData();

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const { isDismissed, dismiss } = useManualLendNotice();
  const [manualLendRequest, setManualLendRequest] =
    useState<BorrowRequest | null>(null);
  const [dontRemind, setDontRemind] = useState(false);

  const ownerNameLookup = useMemo(
    () => buildOwnerNameLookup(members),
    [members],
  );

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

  /** Show the Readmoo member picker and await a pick or cancel. It only collects the choice; the
   *  PATCH and the Readmoo dialog dismissal belong to `handleApproveLending`. */
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

  /** Approve a PENDING request: drive Readmoo's native lending, mark it LENT once that dialog closes.
   *  n ≥ 2 with no matching readmooName shows the picker, which PATCHes it before the click. */
  const handleApproveLending = useCallback(
    async (request: BorrowRequest) => {
      setActionError(null);
      setPendingRequestId(request.requestId);
      // Set only once openLendDialogForBook has submitted the search; stays null (no restore)
      // when it throws before searching, e.g. NOT_ON_LIBRARY.
      let previousQuery: string | null = null;
      try {
        const borrower = members.find((m) => m.userId === request.borrowerId);
        const readmooName = borrower?.readmooName;

        const {
          lendDialog,
          members: readmooMembers,
          previousQuery: prev,
        } = await openLendDialogForBook(request.bookId, request.bookTitle);
        previousQuery = prev;
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
        await apiClient.updateBorrowStatus(
          request.requestId,
          BorrowStatus.LENT,
        );
        // Optimistic local update instead of re-fetch (KV eventual consistency).
        applyBorrowStatus(request.requestId, BorrowStatus.LENT);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "借出失敗";
        setActionError(`自動借出失敗：${msg}`);
      } finally {
        // Restore the prior library search (best-effort) after the whole flow, picker cancel
        // included, so no click lands on a detached card node.
        if (previousQuery !== null) {
          // ORDER MATTERS: close a lingering .book-detail-modal first — MEMBER_NOT_FOUND, CONFIRM_TIMEOUT,
          // a failed PATCH or picker cancel can leave it open to stack on the re-rendered grid.
          dismissOpenDialogs();
          await restoreLibrarySearch(previousQuery);
        }
        setPendingRequestId(null);
      }
    },
    [apiClient, members, applyBorrowStatus, requestPick],
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
        // Same rate-limited PATCH as MemberList's toggles — a 429 here must
        // show the localized back-off copy, not the raw "CODE: message".
        const msg = memberSettingsErrorMessage(err, "儲存失敗");
        setPicker((prev) =>
          prev ? { ...prev, saving: false, errorMessage: msg } : prev,
        );
      }
    },
    [picker, apiClient, familyId, updateMember],
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
            label: "手動借出",
            variant: "secondary",
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
    [handleApproveLending, handleManualLend, pendingRequestId, updateStatus],
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
    [pendingRequestId, updateStatus],
  );

  const resolveIncomingOtherParty = useCallback(
    (req: BorrowRequest) =>
      req.borrowerName ||
      ownerNameLookup.get(req.borrowerId) ||
      req.borrowerId.slice(0, 8),
    [ownerNameLookup],
  );

  const resolveOutgoingOtherParty = useCallback(
    (req: BorrowRequest) =>
      ownerNameLookup.get(req.ownerId) ?? req.ownerId.slice(0, 8),
    [ownerNameLookup],
  );

  if (borrowRequestsState === "idle" || borrowRequestsState === "loading") {
    return (
      <div className="moo-borrow-tab__state moo-borrow-tab__state--center">
        載入借閱資料中...
      </div>
    );
  }

  if (borrowRequestsState === "error") {
    return (
      <div className="moo-borrow-tab__state">
        <p className="moo-borrow-tab__state-error">
          {borrowRequestsError ?? "載入失敗"}
        </p>
        <button
          onClick={() => void refreshBorrowRequests()}
          className="moo-button moo-button--outline moo-borrow-tab__state-retry"
        >
          重試
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="moo-borrow-tab__heading">借閱管理</h3>
      {actionError && (
        <div role="alert" className="moo-borrow-tab__alert">
          {actionError}
        </div>
      )}
      <BorrowSection
        title="收件匣"
        active={incoming.active}
        archived={incoming.archived}
        historyHint={BORROW_HISTORY_HINT_INCOMING}
        renderActions={renderIncomingActions}
        resolveOtherPartyName={resolveIncomingOtherParty}
      />
      <BorrowSection
        title="寄件匣"
        active={outgoing.active}
        archived={outgoing.archived}
        historyHint={BORROW_HISTORY_HINT_OUTGOING}
        renderActions={renderOutgoingActions}
        resolveOtherPartyName={resolveOutgoingOtherParty}
      />
      {picker && (
        <ReadmooMemberPicker
          borrowerName={
            picker.request.borrowerName || picker.request.borrowerId.slice(0, 8)
          }
          options={picker.options}
          saving={picker.saving}
          errorMessage={picker.errorMessage}
          onPick={(member) => void handlePickerPick(member)}
          onCancel={handlePickerCancel}
        />
      )}
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
