import type { RawFamilyBookshelf } from "../api/client";
import type { MemberBooks } from "./FamilyDataContext";

export interface BookshelfSeenRecord {
  [userId: string]: {
    lastUpdated: string;
    bookIds: string[];
  };
}

export interface BookshelfChipsRecord {
  bookIds: string[];
  expiresAt: string;
}

export function seenKey(userId: string): string {
  return `familyBookshelfSeen:${userId}`;
}

export function chipsKey(userId: string): string {
  return `familyBookshelfChips:${userId}`;
}

/** Compare current bookshelf with stored baseline to find newly added bookIds. */
export function computeFreshBookIds(
  decryptedMembers: MemberBooks[],
  rawMembers: RawFamilyBookshelf["members"],
  currentUserId: string,
  seenData: BookshelfSeenRecord,
): Set<string> {
  if (Object.keys(seenData).length === 0) return new Set(); // first use

  const freshIds = new Set<string>();
  for (const member of decryptedMembers) {
    if (member.userId === currentUserId) continue; // exclude self

    const rawMember = rawMembers.find((m) => m.userId === member.userId);
    const seen = seenData[member.userId];

    if (!seen) {
      // New member joined — all their books are new
      for (const book of member.books) freshIds.add(book.bookId);
      continue;
    }

    if (!rawMember?.lastUpdated || rawMember.lastUpdated === seen.lastUpdated) {
      continue; // no change since last seen
    }

    // Diff bookIds to find additions
    const oldIds = new Set(seen.bookIds);
    for (const book of member.books) {
      if (!oldIds.has(book.bookId)) freshIds.add(book.bookId);
    }
  }
  return freshIds;
}

/** Load persisted chip bookIds that haven't expired and still exist in current data. */
export function loadValidChipBookIds(
  chipsData: BookshelfChipsRecord | null,
  currentBookIds: Set<string>,
): Set<string> {
  if (!chipsData || new Date(chipsData.expiresAt).getTime() <= Date.now()) {
    return new Set();
  }
  const valid = new Set<string>();
  for (const id of chipsData.bookIds) {
    if (currentBookIds.has(id)) valid.add(id);
  }
  return valid;
}

/**
 * Build a baseline record from current bookshelf state.
 * Only includes current members — stale entries from departed members are dropped.
 */
export function buildSeenBaseline(
  decryptedMembers: MemberBooks[],
  rawMembers: RawFamilyBookshelf["members"],
): BookshelfSeenRecord {
  const baseline: BookshelfSeenRecord = {};
  for (const member of decryptedMembers) {
    const rawMember = rawMembers.find((m) => m.userId === member.userId);
    baseline[member.userId] = {
      lastUpdated: rawMember?.lastUpdated ?? "",
      bookIds: member.books.map((b) => b.bookId),
    };
  }
  return baseline;
}
