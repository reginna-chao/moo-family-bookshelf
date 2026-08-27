/**
 * Per-entity text sanitizers for backend payloads — the layer the two API
 * clients actually call. The threat model, and why the degraded value is `""`,
 * are documented once in `./safeText.ts`.
 *
 * Parameter types are structural and generic, the same convention as
 * `publicShelf/diff.ts`: neither app's entity types are imported here, so
 * `shared/` keeps no dependency on either consumer, and every field a caller
 * declares beyond the text ones — `BoolFlag` flags, numbers, timestamps,
 * `PersonalBooks`' index-signature extras — survives untouched.
 *
 * An optional field is rebuilt as `field === undefined ? undefined : safeText(…)`
 * so absence stays absence. That writes an explicit `undefined` own property,
 * which is harmless on the write paths: `JSON.stringify` drops explicit
 * `undefined`, so a payload round-tripped back through `PUT /api/user/:id/books`
 * is byte-identical to before.
 *
 * `authToken` is the one declared-`string` field deliberately left alone: it is
 * a credential, never rendered and never passed to a string method, and
 * degrading it to `""` would hide a broken backend behind a silent re-auth loop
 * instead of the 401 the request already produces.
 */

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

/** `coverUrl` is excluded on purpose — see the note in `./safeText.ts`. */
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
    readmooName:
      member.readmooName === undefined
        ? undefined
        : safeText(member.readmooName),
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
    apiEndpoint:
      group.apiEndpoint === undefined
        ? undefined
        : safeNullableText(group.apiEndpoint),
  };
}

export interface BookshelfMemberTextFields {
  userId: string;
  displayName: string;
  books: BookTextFields[];
  /** PWA-only (`string | null`); the Extension's member shape omits it. */
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
    lastUpdated:
      member.lastUpdated === undefined
        ? undefined
        : safeNullableText(member.lastUpdated),
  };
}

export interface FamilyBookshelfTextFields {
  members: BookshelfMemberTextFields[];
  /** PWA-only; the Extension's bookshelf shape omits it. */
  familyId?: string;
}

export function sanitizeFamilyBookshelfText<
  T extends FamilyBookshelfTextFields,
>(bookshelf: T): T {
  return {
    ...bookshelf,
    members: sanitizeList(bookshelf.members, sanitizeBookshelfMemberText),
    familyId:
      bookshelf.familyId === undefined
        ? undefined
        : safeText(bookshelf.familyId),
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

/** `status` is excluded: its render site already hardens it through a
 *  `ReadonlyMap` lookup, and coercing it would break its enum type. */
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
