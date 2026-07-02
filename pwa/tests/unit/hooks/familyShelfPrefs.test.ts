import { describe, it, expect } from "vitest";
import {
  familyPrefRef,
  countHidden,
  countFavorites,
  countRefs,
} from "@/hooks/familyShelfPrefs";
import type { MemberBooks } from "@/hooks/useFamilyData";
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
    expect(countHidden(members, new Set(["owner-1:b1", "owner-2:b3"]))).toBe(2);
  });

  it("ignores orphan refs that do not match any current card", () => {
    const hidden = new Set(["owner-1:b1", "owner-9:ghost", "ghost:b1"]);
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
    expect(countFavorites(members, new Set(["owner-1:b1", "owner-2:b3"]))).toBe(2);
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

  it("drives both countHidden and countFavorites with identical logic", () => {
    const refs = new Set(["owner-1:b2"]);
    expect(countRefs(members, refs)).toBe(countHidden(members, refs));
    expect(countRefs(members, refs)).toBe(countFavorites(members, refs));
  });
});
