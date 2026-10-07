/** Borrow wire types both apps re-export (a field on one end only is a contract break). A CLAIM, not
 *  a guarantee: `./validation` checks the wire values at each app's API boundary. */

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
