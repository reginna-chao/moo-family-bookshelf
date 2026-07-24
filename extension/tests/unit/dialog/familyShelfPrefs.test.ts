import { describe, it, expect } from "vitest";
import {
  familyPrefRef,
  countHidden,
  countFavorites,
  countRefs,
} from "@/dialog/familyShelfPrefs";
import type { MemberBooks } from "@/dialog/FamilyDataContext";
import { BoolFlag } from "@/api/client";

function makeBook(bookId: string) {
  return {
    bookId,
    title: `Book ${bookId}`,
    author: "Author",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

function makeMember(userId: string, bookIds: string[]): MemberBooks {
  return {
    userId,
    displayName: userId,
    books: bookIds.map(makeBook),
  };
}

describe("familyPrefRef", () => {
  it.each([
    ["owner-1", "book-1", "owner-1:book-1"],
    ["u", "b", "u:b"],
    ["abc", "", "abc:"],
    ["", "xyz", ":xyz"],
  ])("formats (%s, %s) as %s", (ownerId, bookId, expected) => {
    expect(familyPrefRef(ownerId, bookId)).toBe(expected);
  });

  it("joins ownerId and bookId with a single colon", () => {
    expect(familyPrefRef("user-A", "book-99")).toBe("user-A:book-99");
  });
});

describe("countHidden", () => {
  const members: MemberBooks[] = [
    makeMember("owner-1", ["b1", "b2"]),
    makeMember("owner-2", ["b3"]),
  ];

  it("returns 0 when no refs are hidden", () => {
    expect(countHidden(members, new Set())).toBe(0);
  });

  it("counts refs that match current cards", () => {
    const hidden = new Set(["owner-1:b1", "owner-2:b3"]);
    expect(countHidden(members, hidden)).toBe(2);
  });

  it("ignores orphan refs that do not match any current card", () => {
    const hidden = new Set(["owner-1:b1", "owner-9:ghost", "ghost:b1"]);
    // Only owner-1:b1 matches a current card.
    expect(countHidden(members, hidden)).toBe(1);
  });

  it("counts only real refs in a mix of real and orphan refs", () => {
    const hidden = new Set([
      "owner-1:b1",
      "owner-1:b2",
      "owner-2:b3",
      "owner-2:orphan",
      "deleted-owner:b1",
    ]);
    expect(countHidden(members, hidden)).toBe(3);
  });

  it("does not double-count when same bookId belongs to different owners", () => {
    const sharedBookMembers: MemberBooks[] = [
      makeMember("owner-1", ["same"]),
      makeMember("owner-2", ["same"]),
    ];
    // Only owner-1's copy is hidden.
    const hidden = new Set(["owner-1:same"]);
    expect(countHidden(sharedBookMembers, hidden)).toBe(1);
  });

  it("returns 0 for empty members regardless of hidden refs", () => {
    expect(countHidden([], new Set(["owner-1:b1"]))).toBe(0);
  });
});

describe("countFavorites", () => {
  const members: MemberBooks[] = [
    makeMember("owner-1", ["b1", "b2"]),
    makeMember("owner-2", ["b3"]),
  ];

  it("returns 0 when no refs are favorited", () => {
    expect(countFavorites(members, new Set())).toBe(0);
  });

  it("counts refs that match current cards", () => {
    const favorites = new Set(["owner-1:b1", "owner-2:b3"]);
    expect(countFavorites(members, favorites)).toBe(2);
  });

  it("ignores orphan refs that do not match any current card", () => {
    const favorites = new Set(["owner-1:b1", "owner-9:ghost", "ghost:b1"]);
    expect(countFavorites(members, favorites)).toBe(1);
  });

  it("counts only real refs in a mix of real and orphan refs", () => {
    const favorites = new Set([
      "owner-1:b1",
      "owner-1:b2",
      "owner-2:b3",
      "owner-2:orphan",
      "deleted-owner:b1",
    ]);
    expect(countFavorites(members, favorites)).toBe(3);
  });

  it("does not double-count when same bookId belongs to different owners", () => {
    const sharedBookMembers: MemberBooks[] = [
      makeMember("owner-1", ["same"]),
      makeMember("owner-2", ["same"]),
    ];
    expect(countFavorites(sharedBookMembers, new Set(["owner-1:same"]))).toBe(
      1,
    );
  });

  it("returns 0 for empty members regardless of favorite refs", () => {
    expect(countFavorites([], new Set(["owner-1:b1"]))).toBe(0);
  });
});

describe("countRefs", () => {
  const members: MemberBooks[] = [
    makeMember("owner-1", ["b1", "b2"]),
    makeMember("owner-2", ["b3"]),
  ];

  it("counts refs against current cards, ignoring orphans (generalized helper)", () => {
    const refs = new Set(["owner-1:b1", "owner-2:b3", "orphan:x"]);
    expect(countRefs(members, refs)).toBe(2);
  });

  it("is independent of ref kind (same logic drives hidden and favorites)", () => {
    const refs = new Set(["owner-1:b2"]);
    expect(countRefs(members, refs)).toBe(countHidden(members, refs));
    expect(countRefs(members, refs)).toBe(countFavorites(members, refs));
  });
});
