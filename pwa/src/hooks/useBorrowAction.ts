import { useCallback, useMemo, useState } from "react";
import { buildBorrowFailureText } from "moo-family-bookshelf-shared/borrow/messages";
import {
  ApiError,
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
} from "@/api/client";
import type { BookWithMember } from "@/hooks/useFamilyShelfBooks";

export interface UseBorrowActionParams {
  apiClient: ApiClient;
  familyId: string;
  /** The viewer — the borrower of every request this hook creates. */
  userId: string;
  borrowRequests: BorrowRequest[];
  refreshBorrowRequests: () => Promise<void>;
}

export interface BorrowAction {
  /** Send a borrow request for one book. Never rejects — failures land in `failureText`. */
  borrow: (book: BookWithMember) => Promise<void>;
  /** 繁體中文 report for the latest FAILED create; empty while none is outstanding. */
  failureText: string;
  /** Attempt number behind that report, bumped on every failure only. Put it on the banner's `key`:
   *  an identical repeat failure must re-mount the live region, or it never re-announces. */
  failureKey: number;
  /** bookIds the viewer already has a PENDING request for (button shows 申請中). */
  pendingBookIds: Set<string>;
}

/** The outstanding report and the attempt that produced it, updated as one unit. */
interface BorrowFailure {
  text: string;
  attempt: number;
}

const NO_BORROW_FAILURE: BorrowFailure = { text: "", attempt: 0 };

/** 繁體中文 for a rejected borrow create; a non-`ApiError` has no `code` and gets the generic copy. No
 *  synthesized-error passthrough, on purpose: .claude/rules/frontend.md → Extension ↔ PWA twins. */
function borrowFailureText(error: unknown): string {
  return buildBorrowFailureText(
    error instanceof ApiError ? error.code : undefined,
  );
}

/**
 * The family shelf's 「申請借閱」 side effect, the report it owes the user, and
 * the viewer's own pending-request set — all three read from the same
 * `borrowRequests` list this hook's refresh updates, so they belong together.
 *
 * Mirrors `extension/src/dialog/useBorrowAction.ts` — same endpoint, same
 * failures, same return shape, same wording (the copy itself lives in
 * `moo-family-bookshelf-shared/borrow/messages`). The single documented
 * divergence is the synthesized-error passthrough the extension has and this
 * client cannot — see `borrowFailureText` above.
 *
 * Why it exists: both borrow handlers used to swallow every rejection with a
 * bare `catch {}`, on the theory that "errors surface via the borrow tab".
 * They cannot — a failed create wrote no request, so the borrow tab has
 * nothing to show. DUPLICATE_REQUEST / RATE_LIMITED / LENDING_DISABLED and a
 * plain network failure all produced zero feedback on the button.
 *
 * The two awaits are deliberately NOT in one `try`. Once the create resolves
 * the request exists on the server; a rejected refresh only means the on-screen
 * list is stale, and reporting that as a borrow failure would tell the user the
 * opposite of the truth.
 *
 * No timers: the text clears on the next successful borrow and never auto-
 * dismisses, so there is no handle to leak.
 */
export function useBorrowAction({
  apiClient,
  familyId,
  userId,
  borrowRequests,
  refreshBorrowRequests,
}: UseBorrowActionParams): BorrowAction {
  const [failure, setFailure] = useState<BorrowFailure>(NO_BORROW_FAILURE);

  const pendingBookIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of borrowRequests) {
      if (r.borrowerId === userId && r.status === BorrowStatus.PENDING) {
        set.add(r.bookId);
      }
    }
    return set;
  }, [borrowRequests, userId]);

  const borrow = useCallback(
    async (book: BookWithMember) => {
      try {
        await apiClient.createBorrowRequest(familyId, {
          bookId: book.bookId,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookCoverUrl: book.coverUrl,
          ownerId: book.ownerId,
        });
      } catch (err) {
        // A new attempt number on EVERY failure, repeats included — it re-mounts the banner so the
        // live region speaks again.
        const text = borrowFailureText(err);
        setFailure((prev) => ({ text, attempt: prev.attempt + 1 }));
        return;
      }
      // Success clears the text but never advances the counter; keeping `prev` when nothing is
      // outstanding spares the whole shelf a re-render on the common path.
      setFailure((prev) => (prev.text === "" ? prev : { ...prev, text: "" }));
      try {
        await refreshBorrowRequests();
      } catch {
        // The request exists; only the refresh failed, which the borrow page's own error state
        // already reports. Never surface it as a borrow failure.
      }
    },
    [apiClient, familyId, refreshBorrowRequests],
  );

  return {
    borrow,
    failureText: failure.text,
    failureKey: failure.attempt,
    pendingBookIds,
  };
}
