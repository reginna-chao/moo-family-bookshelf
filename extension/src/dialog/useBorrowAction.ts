import { useCallback, useMemo, useState } from "react";
import { buildBorrowFailureText } from "moo-family-bookshelf-shared/borrow/messages";
import {
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
} from "../api/client";
import { ApiError } from "../api/types";
import type { FamilyShelfBook } from "./useFamilyShelfBooks";

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
  borrow: (book: FamilyShelfBook) => Promise<void>;
  /** 繁體中文 report for the latest FAILED create; empty while none is outstanding. */
  failureText: string;
  /** bookIds the viewer already has a PENDING request for (button shows 申請中). */
  pendingBookIds: Set<string>;
}

/**
 * Only an `ApiError` carries the machine-readable `code`. Anything else (a
 * bug in the client, an aborted request) has none, and the copy module maps
 * `undefined` to its generic sentence.
 */
function borrowFailureCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

/**
 * The family shelf's 「申請借閱」 side effect, the report it owes the user, and
 * the viewer's own pending-request set — all three read from the same
 * `borrowRequests` list this hook's refresh updates, so they belong together.
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
  const [failureText, setFailureText] = useState("");

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
    async (book: FamilyShelfBook) => {
      try {
        await apiClient.createBorrowRequest(familyId, {
          bookId: book.bookId,
          bookTitle: book.title,
          bookAuthor: book.author,
          bookCoverUrl: book.coverUrl,
          ownerId: book.ownerId,
        });
      } catch (err) {
        setFailureText(buildBorrowFailureText(borrowFailureCode(err)));
        return;
      }
      setFailureText("");
      try {
        await refreshBorrowRequests();
      } catch {
        // The request was created; only the list refresh failed, and
        // `refreshBorrowRequests` already reports that through the borrow
        // tab's own error state. Never surface it as a borrow failure.
      }
    },
    [apiClient, familyId, refreshBorrowRequests],
  );

  return { borrow, failureText, pendingBookIds };
}
