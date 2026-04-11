/**
 * KV key patterns and helpers.
 *
 * Key patterns:
 *   user:{userId}    → encrypted personal book list + sharing settings
 *   family:{familyId} → family member list (JSON)
 *   member:{userId}  → familyId (reverse lookup)
 */

export const kvKeys = {
  user: (userId: string) => `user:${userId}`,
  family: (familyId: string) => `family:${familyId}`,
  member: (userId: string) => `member:${userId}`,
  auth: (userId: string) => `auth:${userId}`,
  authToken: (token: string) => `token:${token}`,
  verify: (userId: string) => `verify:${userId}`,
  otp: (userId: string) => `otp:${userId}`,
} as const;

export interface FamilyMember {
  userId: string;
  displayName: string;
}

export interface FamilyRecord {
  familyId: string;
  ownerId: string;
  members: FamilyMember[];
  maxMembers: number;
  createdAt: string;
  apiEndpoint?: string;
  keyFingerprint: string;
}

/** Raw family record from KV — may lack fields added after initial release. */
export type RawFamilyRecord = Partial<FamilyRecord> & Pick<FamilyRecord, 'familyId' | 'members' | 'createdAt' | 'keyFingerprint'>;

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
  if (!record.keyFingerprint) {
    throw new Error("Corrupted family record: keyFingerprint missing");
  }
  const firstMember = record.members[0];
  const ownerId = record.ownerId ?? (typeof firstMember === 'string' ? firstMember : firstMember.userId);
  const normalized: FamilyRecord = {
    ...record,
    ownerId,
    maxMembers: record.maxMembers ?? 2,
  };
  return normalized;
}

export interface UserBooksRecord {
  payload: string; // encrypted
  lastUpdated: string;
}

export interface AuthRecord {
  token: string;
  createdAt: string;
}

/** Token TTL: 90 days in seconds. Shared by auth middleware and routes. */
export const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

/** OTP TTL: 5 minutes in seconds. */
export const OTP_TTL_SECONDS = 5 * 60;

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
