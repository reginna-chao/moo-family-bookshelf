import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeFreshBookIds,
  loadValidChipBookIds,
  buildSeenBaseline,
  type BookshelfSeenRecord,
  type BookshelfChipsRecord,
} from "@/dialog/updateTracking";
import type { MemberBooks } from "@/dialog/FamilyDataContext";
import { BoolFlag } from "@/api/client";
import type { RawFamilyBookshelf } from "@/api/client";

function makeBook(bookId: string, title = bookId) {
  return {
    bookId,
    title,
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
    books: bookIds.map((id) => makeBook(id)),
  };
}

function makeRawMember(
  userId: string,
  lastUpdated: string | null,
): RawFamilyBookshelf["members"][number] {
  return { userId, payload: null, lastUpdated };
}

describe("computeFreshBookIds", () => {
  it("returns empty set on first use (empty seenData)", () => {
    const members = [makeMember("user-a", ["b1", "b2"])];
    const raw = [makeRawMember("user-a", "2026-01-01T00:00:00Z")];
    const result = computeFreshBookIds(members, raw, "me", {});
    expect(result.size).toBe(0);
  });

  it("excludes self from fresh detection", () => {
    const members = [makeMember("me", ["b1", "b2"])];
    const raw = [makeRawMember("me", "2026-01-02T00:00:00Z")];
    const seen: BookshelfSeenRecord = {
      me: { lastUpdated: "2026-01-01T00:00:00Z", bookIds: [] },
    };
    const result = computeFreshBookIds(members, raw, "me", seen);
    expect(result.size).toBe(0);
  });

  it("detects new books when lastUpdated changed", () => {
    const members = [makeMember("user-a", ["b1", "b2", "b3"])];
    const raw = [makeRawMember("user-a", "2026-01-02T00:00:00Z")];
    const seen: BookshelfSeenRecord = {
      user_a_placeholder: { lastUpdated: "", bookIds: [] },
      "user-a": { lastUpdated: "2026-01-01T00:00:00Z", bookIds: ["b1"] },
    };
    const result = computeFreshBookIds(members, raw, "me", seen);
    expect(result).toEqual(new Set(["b2", "b3"]));
  });

  it("returns empty when lastUpdated is unchanged", () => {
    const ts = "2026-01-01T00:00:00Z";
    const members = [makeMember("user-a", ["b1", "b2"])];
    const raw = [makeRawMember("user-a", ts)];
    const seen: BookshelfSeenRecord = {
      "user-a": { lastUpdated: ts, bookIds: ["b1"] },
    };
    const result = computeFreshBookIds(members, raw, "me", seen);
    expect(result.size).toBe(0);
  });

  it("treats all books as new for a new member", () => {
    const members = [makeMember("user-new", ["b1", "b2"])];
    const raw = [makeRawMember("user-new", "2026-01-01T00:00:00Z")];
    const seen: BookshelfSeenRecord = {
      "user-old": { lastUpdated: "2025-12-01T00:00:00Z", bookIds: ["x1"] },
    };
    const result = computeFreshBookIds(members, raw, "me", seen);
    expect(result).toEqual(new Set(["b1", "b2"]));
  });

  it("handles member with null lastUpdated", () => {
    const members = [makeMember("user-a", ["b1"])];
    const raw = [makeRawMember("user-a", null)];
    const seen: BookshelfSeenRecord = {
      "user-a": { lastUpdated: "2026-01-01T00:00:00Z", bookIds: [] },
    };
    const result = computeFreshBookIds(members, raw, "me", seen);
    expect(result.size).toBe(0);
  });
});

describe("loadValidChipBookIds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty set when chipsData is null", () => {
    const result = loadValidChipBookIds(null, new Set(["b1"]));
    expect(result.size).toBe(0);
  });

  it("returns empty set when chips have expired", () => {
    const chips: BookshelfChipsRecord = {
      bookIds: ["b1", "b2"],
      expiresAt: "2026-04-05T12:00:00Z", // yesterday
    };
    const result = loadValidChipBookIds(chips, new Set(["b1", "b2"]));
    expect(result.size).toBe(0);
  });

  it("returns valid chip bookIds that exist in current data", () => {
    const chips: BookshelfChipsRecord = {
      bookIds: ["b1", "b2", "b3"],
      expiresAt: "2026-04-07T12:00:00Z", // tomorrow
    };
    const currentIds = new Set(["b1", "b3", "b4"]);
    const result = loadValidChipBookIds(chips, currentIds);
    expect(result).toEqual(new Set(["b1", "b3"]));
  });

  it("filters out bookIds no longer in current data", () => {
    const chips: BookshelfChipsRecord = {
      bookIds: ["b1", "b2"],
      expiresAt: "2026-04-07T12:00:00Z",
    };
    const result = loadValidChipBookIds(chips, new Set(["b3"]));
    expect(result.size).toBe(0);
  });
});

describe("buildSeenBaseline", () => {
  it("builds baseline from decrypted members and raw data", () => {
    const decrypted = [
      makeMember("user-a", ["b1", "b2"]),
      makeMember("user-b", ["b3"]),
    ];
    const raw = [
      makeRawMember("user-a", "2026-01-01T00:00:00Z"),
      makeRawMember("user-b", "2026-01-02T00:00:00Z"),
    ];
    const baseline = buildSeenBaseline(decrypted, raw);
    expect(baseline).toEqual({
      "user-a": { lastUpdated: "2026-01-01T00:00:00Z", bookIds: ["b1", "b2"] },
      "user-b": { lastUpdated: "2026-01-02T00:00:00Z", bookIds: ["b3"] },
    });
  });

  it("only includes current members (drops stale entries)", () => {
    const decrypted = [makeMember("user-a", ["b1"])];
    const raw = [makeRawMember("user-a", "2026-01-01T00:00:00Z")];
    const baseline = buildSeenBaseline(decrypted, raw);
    expect(Object.keys(baseline)).toEqual(["user-a"]);
  });

  it("uses empty string when raw member has null lastUpdated", () => {
    const decrypted = [makeMember("user-a", ["b1"])];
    const raw = [makeRawMember("user-a", null)];
    const baseline = buildSeenBaseline(decrypted, raw);
    expect(baseline["user-a"].lastUpdated).toBe("");
  });

  it("handles member not found in raw data", () => {
    const decrypted = [makeMember("user-a", ["b1"])];
    const raw: ReturnType<typeof makeRawMember>[] = [];
    const baseline = buildSeenBaseline(decrypted, raw);
    expect(baseline["user-a"].lastUpdated).toBe("");
  });
});
