/**
 * Borrow wire-contract types — the shape of `/api/family/:id/borrow` and
 * `/api/borrow/:id` payloads as the Extension and the PWA agree to read them.
 *
 * Single-sourced here because both apps consume the same endpoints from the same
 * 「申請借閱」 flow, so a field that exists on one end and not the other is a
 * contract break rather than a local style choice. Each app re-exports these from
 * its own API module, so existing importers are unaffected.
 *
 * These types are a CLAIM about the payload, never a guarantee: the backend is
 * user-configurable (BYO / a sync code's `@host`), so the actual wire values are
 * checked at each app's API boundary by `./validation`.
 */

export enum BorrowStatus {
  PENDING = 0,
  LENT = 1,
  RETURNED = 2,
  REJECTED = 3,
  CANCELLED = 4,
}

export interface BorrowRequest {
  requestId: string;
  familyId: string;
  borrowerId: string;
  borrowerName: string;
  ownerId: string;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  bookCoverUrl: string;
  status: BorrowStatus;
  createdAt: string;
  updatedAt: string;
}

/** Payload for creating a borrow request. */
export interface CreateBorrowPayload {
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  bookCoverUrl: string;
  ownerId: string;
}
