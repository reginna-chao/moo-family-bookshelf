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
}

/** Raw family record from KV — may lack fields added after initial release. */
export type RawFamilyRecord = Partial<FamilyRecord> & Pick<FamilyRecord, 'familyId' | 'members' | 'createdAt'>;

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
