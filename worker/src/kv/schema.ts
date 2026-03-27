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
} as const;

export interface FamilyRecord {
  familyId: string;
  ownerId: string;
  members: string[];
  maxMembers: number;
  createdAt: string;
}

/** Raw family record from KV — may lack fields added after initial release. */
export type RawFamilyRecord = Partial<FamilyRecord> & Pick<FamilyRecord, 'familyId' | 'members' | 'createdAt'>;

export function normalizeFamilyRecord(record: RawFamilyRecord): FamilyRecord {
  if (record.members.length === 0) {
    throw new Error("Corrupted family record: members array is empty");
  }
  return {
    ...record,
    ownerId: record.ownerId ?? record.members[0],
    maxMembers: record.maxMembers ?? 2,
  };
}

export interface UserBooksRecord {
  payload: string; // encrypted
  lastUpdated: string;
}
