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
  members: string[];
  createdAt: string;
}

export interface UserBooksRecord {
  payload: string; // encrypted
  lastUpdated: string;
}
