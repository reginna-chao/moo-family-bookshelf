import { useCallback, useMemo, useState } from "react";
import { buildBorrowFailureText } from "moo-family-bookshelf-shared/borrow/messages";
import {
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
} from "../api/client";
import { ApiError, AUTH_REFRESH_RATE_LIMITED } from "../api/types";
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
  /**
   * Attempt number behind that report — incremented on every failure, never on
   * a success. Belongs on the banner's `key`: pressing the same book twice and
   * failing the same way writes an IDENTICAL `failureText`, React bails out,
   * and a live region that never re-mounts never re-announces — the "pressed
   * it, nothing happened" symptom this banner exists to remove.
   */
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

/**
 * User-facing 繁體中文 for a rejected borrow create.
 *
 * Only an `ApiError` carries the machine-readable `code`. Anything else (a
 * bug in the client, an aborted request) has none, and the copy module maps
 * `undefined` to its generic sentence.
 *
 * The one exception to the copy module's "code in, local string out" rule is
 * the client-synthesized auth-recovery throttle, which passes through verbatim
 * exactly as `memberSettingsMessages.ts` and `publicShareMessages.ts` handle
 * it: its message is already user-facing 繁體中文 and names a concrete cooldown
 * that the shared table, seeing only a code, cannot reconstruct. `synthesized`
 * — not the code — is the authority for that passthrough: only this client's
 * own symbol marker sets it, so a self-hosted (BYO) or hostile backend cannot
 * return the code and get arbitrary text painted into the shelf.
 */
function borrowFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) return buildBorrowFailureText(undefined);
  const mapped = buildBorrowFailureText(error.code);
  if (error.synthesized && error.code === AUTH_REFRESH_RATE_LIMITED) {
    return error.rawMessage || mapped;
  }
  return mapped;
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
        // A new attempt number on EVERY failure, a repeat of the same one
        // included — that counter is what re-mounts the banner so the live
        // region speaks again.
        const text = borrowFailureText(err);
        setFailure((prev) => ({ text, attempt: prev.attempt + 1 }));
        return;
      }
      // Success clears the text and deliberately leaves the counter alone: it
      // must only ever advance on a failure. Keeping `prev` when nothing is
      // outstanding also spares the whole shelf a re-render on the common path.
      setFailure((prev) => (prev.text === "" ? prev : { ...prev, text: "" }));
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

  return {
    borrow,
    failureText: failure.text,
    failureKey: failure.attempt,
    pendingBookIds,
  };
}
