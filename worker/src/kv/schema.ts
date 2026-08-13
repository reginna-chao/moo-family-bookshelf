/**
 * KV key patterns and helpers.
 *
 * Key patterns:
 *   user:{userId}    → personal book list + sharing settings (JSON)
 *   family:{familyId} → family member list (JSON)
 *   member:{userId}  → familyId (reverse lookup)
 *   qr:{token}       → QrTokenRecord (one-time QR login bypass, TTL 300s)
 *   verifyfail:{userId}:{callerKey} → VerifyFailRecord (per-caller failure accounting, TTL 900s)
 *   borrow:{requestId} → BorrowRequest (JSON)
 *   borrows:family:{familyId} → string[] (requestId index)
 *   public:{shareToken} → PublicShelfSnapshot (plaintext public bookshelf, optional TTL)
 */

/** Cloudflare KV rejects any `expirationTtl` below 60 seconds. */
export const KV_MIN_TTL_SECONDS = 60;

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
  verifyFail: (userId: string, callerKey: string) =>
    `verifyfail:${userId}:${callerKey}`,
  otp: (userId: string) => `otp:${userId}`,
  qrToken: (token: string) => `qr:${token}`,
  borrow: (requestId: string) => `borrow:${requestId}`,
  borrowsByFamily: (familyId: string) => `borrows:family:${familyId}`,
  publicShelf: (token: string) => `public:${token}`,
} as const;

export interface FamilyMember {
  userId: string;
  displayName: string;
  canLend: BoolFlag; // 0 = false, 1 = true. Default TRUE for backward compat.
  readmooName?: string; // Readmoo display name for lending automation
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
export type RawFamilyMember = Omit<FamilyMember, "canLend" | "readmooName"> & {
  canLend?: BoolFlag;
  readmooName?: string;
};

/** Raw family record from KV — may lack fields added after initial release. */
export type RawFamilyRecord = Omit<Partial<FamilyRecord>, "members"> & {
  familyId: string;
  members: RawFamilyMember[];
  createdAt: string;
};

/** Find a member by userId in the members array. */
export function findMember(
  members: FamilyMember[],
  userId: string,
): FamilyMember | undefined {
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
  const ownerId =
    record.ownerId ??
    (typeof firstMember === "string" ? firstMember : firstMember.userId);

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
  /**
   * Per-viewer private family-shelf preferences (v1.5.0+).
   * Both lists hold copy-scoped `"{ownerId}:{bookId}"` refs:
   * - `hidden`: refs the viewer has hidden from their own family-shelf view.
   * - `favorites`: refs the viewer has marked as favorites (我的最愛, v1.6.0+).
   * Each list is capped independently at `MAX_FAMILY_PREF_ENTRIES`.
   */
  familyShelfPrefs?: { hidden: string[]; favorites: string[] };
}

/**
 * Max entries allowed in a single familyShelfPrefs list (v1.5.0+).
 *
 * This is a PER-LIST cap: `hidden` and `favorites` are each capped at this
 * count independently. Enforced by `parseFamilyPrefs` in `routes/user.ts`,
 * which returns 400 INVALID_PAYLOAD when a deduped present list exceeds it.
 *
 * Sizing rationale — kept reachable under the body guard:
 *   The global 256KB request-body guard (`MAX_BODY_SIZE = 262144` in
 *   `index.ts`) is the *outer* defense and rejects oversized bodies with 413
 *   before they reach this handler. Each valid entry is
 *   `"{64-hex ownerId}:{bookId}"` and serializes to ~69 bytes of JSON
 *   (including quotes + comma). At 3000 entries an over-limit payload of
 *   3001 refs is ~207KB < 256KB, so it slips past the body guard and actually
 *   triggers the 400 branch here — keeping that branch reachable and testable
 *   over the real HTTP path. A larger cap (e.g. 10000 ≈ 690KB) would always be
 *   pre-empted by the 413 guard, making the 400 branch dead code. Real hidden
 *   counts are far smaller than 3000, so this cap is ample headroom.
 *
 *   Per-list cap vs whole-body guard: the 256KB guard measures the WHOLE
 *   request body, while this cap is PER-LIST. Over-capping BOTH lists at once
 *   (`{ hidden: 3001, favorites: 3001 }` ≈ 414KB) exceeds 256KB and is
 *   pre-empted by the 413 guard, so it never reaches the 400 branch. The 400
 *   branch stays reachable via a SINGLE over-capped list (the other list small
 *   or absent, ~207KB total), which stays under 256KB.
 */
export const MAX_FAMILY_PREF_ENTRIES = 3000;

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
  /**
   * Epoch ms of when the verification secret/method was last changed. Failure
   * records whose streak began before this timestamp are void — the secret they
   * accumulated against no longer exists. Only `PUT /:id/verify` advances it.
   *
   * OPTIONAL on purpose: records already in production KV predate this field,
   * and `kv.get<VerifyRecord>(key, "json")` casts the parsed JSON without
   * validating it — there is no migration step that could backfill them. Typing
   * it as required would be a lie the compiler cannot catch, and would make read
   * sites skip the `undefined` handling they actually need. Absent value means
   * "unknown"; consumers must fall back to the safe (still-locked) behaviour.
   */
  secretUpdatedAt?: number;
}

/**
 * Verification failure accounting, scoped to a (target user, caller) pair and
 * stored under `verifyfail:{userId}:{callerKey}` with a TTL.
 *
 * Deliberately NOT part of `VerifyRecord`: the join endpoint is public and the
 * submitted userId is guessable, so a counter living on the account itself would
 * let any stranger lock the account owner out. Keying on the caller means an
 * attacker can only ever lock themselves out, and the TTL guarantees the entry
 * disappears on its own.
 */
export interface VerifyFailRecord {
  /** Consecutive failed verification attempts from this caller. */
  failCount: number;
  /** Lockout expiry timestamp (ms) for this caller. null if not locked. */
  lockedUntil: number | null;
  /**
   * Epoch ms of when this caller's current failure streak began. Compared
   * against `VerifyRecord.secretUpdatedAt`: a streak that started before the
   * secret was last changed is void. Preserved across a lockout (the streak is
   * the same until the entry expires or is cleared).
   *
   * OPTIONAL for the same reason as `VerifyRecord.secretUpdatedAt`: entries
   * written before this field existed can still be live for up to
   * `VERIFY_FAIL_TTL_SECONDS` after a deploy, and nothing validates the JSON on
   * read. Absent value means "unknown" and must NOT void the record.
   */
  startedAt?: number;
}

export interface OtpRecord {
  code: string;
  createdAt: string;
}

/** Max consecutive failures before lockout. */
export const VERIFY_MAX_FAILURES = 5;
/**
 * Lockout duration: 15 minutes in ms.
 *
 * INVARIANT: `VERIFY_LOCKOUT_MS === VERIFY_FAIL_TTL_SECONDS * 1000`. The entry
 * must expire exactly when the lockout ends. This is what makes it harmless for
 * `chargeFailure` to preserve `startedAt` across the lockout reset: the record
 * cannot outlive its own lockout, so the stale streak start is never reused.
 *
 * If they diverge:
 * - TTL SHORTER than the lockout → the entry vanishes mid-lockout and the
 *   lockout is silently truncated.
 * - TTL LONGER than the lockout → a failure arriving after the lockout ended
 *   continues the pre-lockout streak, so `startedAt` no longer describes the
 *   current streak and the `secretUpdatedAt` void comparison misjudges it.
 */
export const VERIFY_LOCKOUT_MS = 15 * 60 * 1000;
/**
 * TTL for `verifyfail:*` entries: 900s, matching the 15-minute lockout window.
 * Must stay equal to `VERIFY_LOCKOUT_MS` — see the invariant documented there.
 */
export const VERIFY_FAIL_TTL_SECONDS = 15 * 60;
