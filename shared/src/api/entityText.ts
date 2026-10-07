/** Per-entity text sanitizers the two API clients call; structural generic params (no app types),
 *  optionals via conditional spread. Why: docs/architecture.md → 伺服器回傳資料的檢查. */

import {
  safeText,
  safeNullableText,
  sanitizeRecord,
  sanitizeList,
} from "./safeText";

export interface BookTextFields {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  readmooUrl: string;
  category: string;
}

/** `coverUrl` is excluded on purpose — see docs/architecture.md → 伺服器回傳資料的檢查. */
export function sanitizeBookText<T extends BookTextFields>(book: T): T {
  return {
    ...book,
    bookId: safeText(book.bookId),
    title: safeText(book.title),
    author: safeText(book.author),
    isbn: safeText(book.isbn),
    readmooUrl: safeText(book.readmooUrl),
    category: safeText(book.category),
  };
}

export interface MemberTextFields {
  userId: string;
  displayName: string;
  readmooName?: string;
}

/** `userId` matters as much as the names: `userId.slice(0, 8)` is the member
 *  label fallback in both apps. */
export function sanitizeMemberText<T extends MemberTextFields>(member: T): T {
  return {
    ...member,
    userId: safeText(member.userId),
    displayName: safeText(member.displayName),
    ...(member.readmooName !== undefined && {
      readmooName: safeText(member.readmooName),
    }),
  };
}

export interface FamilyGroupTextFields {
  familyId: string;
  ownerId: string;
  createdAt: string;
  members: MemberTextFields[];
  apiEndpoint?: string | null;
}

/** `apiEndpoint` renders as a JSX child in the ownership-transfer warning. */
export function sanitizeFamilyGroupText<T extends FamilyGroupTextFields>(
  group: T,
): T {
  return {
    ...group,
    familyId: safeText(group.familyId),
    ownerId: safeText(group.ownerId),
    createdAt: safeText(group.createdAt),
    members: sanitizeList(group.members, sanitizeMemberText),
    ...(group.apiEndpoint !== undefined && {
      apiEndpoint: safeNullableText(group.apiEndpoint),
    }),
  };
}

export interface BookshelfMemberTextFields {
  userId: string;
  displayName: string;
  books: BookTextFields[];
  /** Required on the wire (`FamilyBookshelfMember.lastUpdated` in `./types.ts`); optional here only
   *  because this layer is structural and does not import that type. */
  lastUpdated?: string | null;
}

export function sanitizeBookshelfMemberText<
  T extends BookshelfMemberTextFields,
>(member: T): T {
  return {
    ...member,
    userId: safeText(member.userId),
    displayName: safeText(member.displayName),
    books: sanitizeList(member.books, sanitizeBookText),
    ...(member.lastUpdated !== undefined && {
      lastUpdated: safeNullableText(member.lastUpdated),
    }),
  };
}

export interface FamilyBookshelfTextFields {
  members: BookshelfMemberTextFields[];
  /** Required on the wire (`FamilyBookshelf.familyId` in `./types.ts`); optional here only
   *  because this layer is structural and does not import that type. */
  familyId?: string;
}

export function sanitizeFamilyBookshelfText<
  T extends FamilyBookshelfTextFields,
>(bookshelf: T): T {
  return {
    ...bookshelf,
    members: sanitizeList(bookshelf.members, sanitizeBookshelfMemberText),
    ...(bookshelf.familyId !== undefined && {
      familyId: safeText(bookshelf.familyId),
    }),
  };
}

export interface PersonalBooksTextFields {
  userId: string;
  displayName: string;
  lastUpdated: string;
  books: BookTextFields[];
}

export function sanitizePersonalBooksText<T extends PersonalBooksTextFields>(
  personal: T,
): T {
  return {
    ...personal,
    userId: safeText(personal.userId),
    displayName: safeText(personal.displayName),
    lastUpdated: safeText(personal.lastUpdated),
    books: sanitizeList(personal.books, sanitizeBookText),
  };
}

export interface BorrowRequestTextFields {
  requestId: string;
  familyId: string;
  borrowerId: string;
  borrowerName: string;
  ownerId: string;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Covers the SINGLE-OBJECT borrow responses only — `POST /api/family/:id/borrow`
 * and `PATCH /api/borrow/:requestId`.
 *
 * The borrow LIST (`GET /api/family/:id/borrow`) deliberately does not come
 * through here: it is owned by the stricter `shared/src/borrow/validation.ts`,
 * which rebuilds all 12 fields from scratch (no spread of the raw element),
 * drops elements without a usable `requestId`, and coerces `bookCoverUrl` as
 * well. Two policies on one entity, so they are cross-linked here: a field
 * added to `BorrowRequest` must be decided for BOTH, or the list and the
 * create/update paths silently diverge.
 *
 * `status` is excluded from both: its render site already hardens it through a
 * `ReadonlyMap` lookup, and coercing it would break its enum type.
 */
export function sanitizeBorrowRequestText<T extends BorrowRequestTextFields>(
  request: T,
): T {
  return {
    ...request,
    requestId: safeText(request.requestId),
    familyId: safeText(request.familyId),
    borrowerId: safeText(request.borrowerId),
    borrowerName: safeText(request.borrowerName),
    ownerId: safeText(request.ownerId),
    bookId: safeText(request.bookId),
    bookTitle: safeText(request.bookTitle),
    bookAuthor: safeText(request.bookAuthor),
    createdAt: safeText(request.createdAt),
    updatedAt: safeText(request.updatedAt),
  };
}

export interface PublicShelfTextFields {
  shelfId: string;
  shareToken: string;
  title: string;
}

export function sanitizePublicShelfText<T extends PublicShelfTextFields>(
  shelf: T,
): T {
  return {
    ...shelf,
    shelfId: safeText(shelf.shelfId),
    shareToken: safeText(shelf.shareToken),
    title: safeText(shelf.title),
  };
}

/** Payload of `GET /api/user/:id/public-shelf`. */
export function sanitizePublicShelfListText<
  T extends { shelves: PublicShelfTextFields[] },
>(list: T): T {
  return {
    ...list,
    shelves: sanitizeList(list.shelves, sanitizePublicShelfText),
  };
}

/** Payload of the create / update / reset-token public-shelf writes. */
export function sanitizePublicShelfResultText<
  T extends { shelf: PublicShelfTextFields },
>(result: T): T {
  return {
    ...result,
    shelf: sanitizeRecord(result.shelf, sanitizePublicShelfText),
  };
}

export interface PublicShelfDataTextFields {
  title: string;
  books: BookTextFields[];
}

/** Payload of the unauthenticated `GET /api/public/:shareToken`. */
export function sanitizePublicShelfDataText<
  T extends PublicShelfDataTextFields,
>(data: T): T {
  return {
    ...data,
    title: safeText(data.title),
    books: sanitizeList(data.books, sanitizeBookText),
  };
}

/** `serverVersion` reaches the user inside the outdated-backend warning copy. */
export function sanitizeVersionInfoText<T extends { serverVersion: string }>(
  info: T,
): T {
  return { ...info, serverVersion: safeText(info.serverVersion) };
}

/** The one-time verification code is rendered verbatim as a JSX child. */
export function sanitizeOtpInfoText<T extends { code: string }>(otp: T): T {
  return { ...otp, code: safeText(otp.code) };
}
