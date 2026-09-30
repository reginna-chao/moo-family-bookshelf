import { describe, it, expect } from "vitest";
import { countVisibleByMemberScope } from "moo-family-bookshelf-shared/familyShelf/memberScopeCounts";
import {
  familyPrefRef,
  type FamilyShelfMemberBooks,
} from "moo-family-bookshelf-shared/familyShelf/prefRefs";

const VIEWER = "user-self";

function member(userId: string, bookIds: string[]): FamilyShelfMemberBooks {
  return { userId, books: bookIds.map((bookId) => ({ bookId })) };
}

// Viewer 2 books, Alice 1, Bob 2, Carol none.
const FAMILY: FamilyShelfMemberBooks[] = [
  member(VIEWER, ["s1", "s2"]),
  member("user-a", ["a1"]),
  member("user-b", ["b1", "b2"]),
  member("user-c", []),
];

interface Case {
  name: string;
  members: FamilyShelfMemberBooks[];
  viewerId?: string;
  hidden: string[];
  all: number;
  allExceptSelf: number;
  byMember: Record<string, number>;
}

const cases: Case[] = [
  {
    name: "counts every book when nothing is hidden",
    members: FAMILY,
    hidden: [],
    all: 5,
    allExceptSelf: 3,
    byMember: { [VIEWER]: 2, "user-a": 1, "user-b": 2, "user-c": 0 },
  },
  {
    name: "subtracts hidden books from both the viewer and other members",
    members: FAMILY,
    hidden: [familyPrefRef(VIEWER, "s1"), familyPrefRef("user-b", "b2")],
    all: 3,
    allExceptSelf: 2,
    byMember: { [VIEWER]: 1, "user-a": 1, "user-b": 1, "user-c": 0 },
  },
  {
    name: "leaves all-except-self untouched when only the viewer's books are hidden",
    members: FAMILY,
    hidden: [familyPrefRef(VIEWER, "s1"), familyPrefRef(VIEWER, "s2")],
    all: 3,
    allExceptSelf: 3,
    byMember: { [VIEWER]: 0, "user-a": 1, "user-b": 2, "user-c": 0 },
  },
  {
    name: "does not subtract orphan refs (unknown owner, unknown book, or a book under the wrong owner)",
    members: FAMILY,
    hidden: [
      familyPrefRef("ghost-owner", "ghost-book"),
      familyPrefRef("user-a", "no-such-book"),
      // s1 exists, but under the viewer — not under Alice.
      familyPrefRef("user-a", "s1"),
    ],
    all: 5,
    allExceptSelf: 3,
    byMember: { [VIEWER]: 2, "user-a": 1, "user-b": 2, "user-c": 0 },
  },
  {
    name: "reports 0 for a member whose every book is hidden",
    members: FAMILY,
    hidden: [familyPrefRef("user-b", "b1"), familyPrefRef("user-b", "b2")],
    all: 3,
    allExceptSelf: 1,
    byMember: { [VIEWER]: 2, "user-a": 1, "user-b": 0, "user-c": 0 },
  },
  {
    name: "treats every member as 'others' when the viewer is not in the list",
    members: FAMILY,
    viewerId: "outsider",
    hidden: [familyPrefRef("user-a", "a1")],
    all: 4,
    allExceptSelf: 4,
    byMember: { [VIEWER]: 2, "user-a": 0, "user-b": 2, "user-c": 0 },
  },
  {
    name: "returns all zeros and an empty map for an empty family",
    members: [],
    hidden: [familyPrefRef("user-a", "a1")],
    all: 0,
    allExceptSelf: 0,
    byMember: {},
  },
];

describe("countVisibleByMemberScope", () => {
  it.each(cases)(
    "$name",
    ({ members, viewerId, hidden, all, allExceptSelf, byMember }) => {
      const counts = countVisibleByMemberScope(
        members,
        viewerId ?? VIEWER,
        new Set(hidden),
      );

      expect(counts.all).toBe(all);
      expect(counts.allExceptSelf).toBe(allExceptSelf);
      expect(Object.fromEntries(counts.byMember)).toEqual(byMember);
    },
  );

  it("has no entry for the viewer when the viewer is not a member", () => {
    const counts = countVisibleByMemberScope(FAMILY, "outsider", new Set());
    expect(counts.byMember.has("outsider")).toBe(false);
  });

  it("sums two list entries that share one userId instead of overwriting", () => {
    const counts = countVisibleByMemberScope(
      [member("user-a", ["a1"]), member("user-a", ["a2", "a3"])],
      VIEWER,
      new Set([familyPrefRef("user-a", "a3")]),
    );
    expect(counts.byMember.get("user-a")).toBe(2);
    expect(counts.all).toBe(2);
  });
});
