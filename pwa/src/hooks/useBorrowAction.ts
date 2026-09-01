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
 * Deliberately NOT a byte-for-byte twin of the extension's helper: that one
 * additionally passes the client-synthesized `AUTH_REFRESH_RATE_LIMITED`
 * message through verbatim, a convention this client does not have — neither
 * the code nor any synthesize path exists in `pwa/src`, so there is nothing to
 * mirror and a passthrough here could only ever render server-supplied text.
 * Same asymmetry, same reason, as documented on `memberSettingsErrorMessage`
 * in `pwa/src/components/MemberList.tsx`. The omission is intentional.
 */
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
        // page's own error state. Never surface it as a borrow failure.
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
