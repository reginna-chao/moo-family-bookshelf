/**
 * KV key patterns and helpers.
 *
 * Key patterns:
 *   user:{userId}    → personal book list + sharing settings (JSON)
 *   family:{familyId} → family member list (JSON)
 *   member:{userId}  → familyId (reverse lookup)
 *   qr:{token}       → QrTokenRecord (one-time QR login bypass, TTL 300s)
 *   borrow:{requestId} → BorrowRequest (JSON)
 *   borrows:family:{familyId} → string[] (requestId index)
 *   public:{shareToken} → PublicShelfSnapshot (plaintext public bookshelf, optional TTL)
 */

export enum BoolFlag {
  FALSE = 0,
  TRUE = 1,
}

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

export const kvKeys = {
  user: (userId: string) => `user:${userId}`,
  family: (familyId: string) => `family:${familyId}`,
  member: (userId: string) => `member:${userId}`,
  auth: (userId: string) => `auth:${userId}`,
  authToken: (token: string) => `token:${token}`,
  verify: (userId: string) => `verify:${userId}`,
  otp: (userId: string) => `otp:${userId}`,
  qrToken: (token: string) => `qr:${token}`,
  borrow: (requestId: string) => `borrow:${requestId}`,
  borrowsByFamily: (familyId: string) => `borrows:family:${familyId}`,
  publicShelf: (token: string) => `public:${token}`,
} as const;

export interface FamilyMember {
  userId: string;
  displayName: string;
  canLend: BoolFlag;     // 0 = false, 1 = true. Default TRUE for backward compat.
  readmooName?: string;  // Readmoo display name for lending automation
}

export interface FamilyRecord {
  familyId: string;
  ownerId: string;
  members: FamilyMember[];
  maxMembers: number;
  createdAt: string;
  apiEndpoint?: string;
}

/**
 * Raw member shape from KV — may lack fields added after initial release
 * (e.g. `canLend`, `readmooName` added in v1.1.0).
 */
export type RawFamilyMember = Omit<FamilyMember, 'canLend' | 'readmooName'> & {
  canLend?: BoolFlag;
  readmooName?: string;
};

/** Raw family record from KV — may lack fields added after initial release. */
export type RawFamilyRecord = Omit<Partial<FamilyRecord>, 'members'> & {
  familyId: string;
  members: RawFamilyMember[];
  createdAt: string;
};

/** Find a member by userId in the members array. */
export function findMember(members: FamilyMember[], userId: string): FamilyMember | undefined {
  return members.find((m) => m.userId === userId);
}

/** Check if a userId exists in the members array. */
export function hasMember(members: FamilyMember[], userId: string): boolean {
  return members.some((m) => m.userId === userId);
}

export function normalizeFamilyRecord(record: RawFamilyRecord): FamilyRecord {
  if (record.members.length === 0) {
    throw new Error("Corrupted family record: members array is empty");
  }
  const firstMember = record.members[0];
  const ownerId = record.ownerId ?? (typeof firstMember === 'string' ? firstMember : firstMember.userId);

  // Backward compat: add canLend default for members that lack it
  const members: FamilyMember[] = record.members.map((m) => ({
    ...m,
    canLend: m.canLend ?? BoolFlag.TRUE,
  }));

  const normalized: FamilyRecord = {
    ...record,
    ownerId,
    members,
    maxMembers: record.maxMembers ?? 2,
  };
  return normalized;
}

export interface BookEntry {
  bookId: string;
  title: string;
  author: string;
  isbn: string;
  coverUrl: string;
  readmooUrl: string;
  category: string;
  isShared: number; // BoolFlag: 0 = false, 1 = true
  isArchived?: number;
}

export type SelectionMode = "all-shared";

export interface PublicShelf {
  shelfId: string;
  shareToken: string;
  title: string;
  expiresDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  selectionMode: SelectionMode;
}

export interface PublicShelfSnapshot {
  userId: string;
  shelfId: string;
  title: string;
  books: BookEntry[];
  createdAt: number;
  expiresAt: number | null;
}

export const MAX_PUBLIC_SHELVES = 1;

export interface UserBooksRecord {
  schemaVersion: number;
  userId: string;
  displayName: string;
  books: BookEntry[];
  lastUpdated: string;
  publicSharing?: { shelves: PublicShelf[] };
  [key: string]: unknown;
}

export interface AuthRecord {
  token: string;
  createdAt: string;
}

/** Token TTL: 90 days in seconds. Shared by auth middleware and routes. */
export const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** OTP TTL: 5 minutes in seconds. */
export const OTP_TTL_SECONDS = 5 * 60;

/** QR token TTL: 5 minutes in seconds. */
export const QR_TOKEN_TTL_SECONDS = 5 * 60;

export interface QrTokenRecord {
  userId: string;
}

/** Verification method for PWA login. */
export type VerifyMethod = "pin" | "pattern" | "code" | "none";

export interface VerifyRecord {
  method: VerifyMethod;
  /** SHA-256(salt + secret). null when method is 'code' or 'none'. */
  hash: string | null;
  /** Random hex salt for hashing. null when method is 'code' or 'none'. */
  salt: string | null;
  /** Whether user has been prompted to set up verification (0 or 1). */
  prompted: number;
  /** Consecutive failed verification attempts. */
  failCount: number;
  /** Lockout expiry timestamp (ms). null if not locked. */
  lockedUntil: number | null;
}

export interface OtpRecord {
  code: string;
  createdAt: string;
}

/** Max consecutive failures before lockout. */
export const VERIFY_MAX_FAILURES = 5;
/** Lockout duration: 15 minutes in ms. */
export const VERIFY_LOCKOUT_MS = 15 * 60 * 1000;
