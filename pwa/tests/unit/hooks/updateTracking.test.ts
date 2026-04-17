import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  seenKey,
  chipsKey,
  readLocalJson,
  writeLocalJson,
  computeFreshBookIds,
  loadValidChipBookIds,
  buildSeenBaseline,
  type BookshelfSeenRecord,
  type BookshelfChipsRecord,
} from "@/hooks/updateTracking";
import type { MemberBooks } from "@/hooks/useFamilyData";
import { BoolFlag } from "@/api/client";
import type { FamilyBookshelf } from "@/api/client";

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
): FamilyBookshelf["members"][number] {
  return { userId, displayName: userId, books: [], lastUpdated };
}

describe("seenKey / chipsKey", () => {
  it("scopes keys by userId", () => {
    expect(seenKey("user-abc")).toBe("familyBookshelfSeen:user-abc");
    expect(chipsKey("user-abc")).toBe("familyBookshelfChips:user-abc");
  });
});

describe("readLocalJson / writeLocalJson", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null for missing key", () => {
    expect(readLocalJson("nonexistent")).toBeNull();
  });

  it("round-trips JSON data", () => {
    const data = { foo: "bar", num: 42 };
    writeLocalJson("test-key", data);
    expect(readLocalJson("test-key")).toEqual(data);
  });

  it("returns null for corrupted JSON", () => {
    localStorage.setItem("bad", "{invalid json");
    expect(readLocalJson("bad")).toBeNull();
  });
});

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
    expect(loadValidChipBookIds(null, new Set(["b1"]))).toEqual(new Set());
  });

  it("returns empty set when chips have expired", () => {
    const chips: BookshelfChipsRecord = {
      bookIds: ["b1"],
      expiresAt: "2026-04-05T12:00:00Z",
    };
    expect(loadValidChipBookIds(chips, new Set(["b1"]))).toEqual(new Set());
  });

  it("returns valid chip bookIds that exist in current data", () => {
    const chips: BookshelfChipsRecord = {
      bookIds: ["b1", "b2", "b3"],
      expiresAt: "2026-04-07T12:00:00Z",
    };
    const result = loadValidChipBookIds(chips, new Set(["b1", "b3"]));
    expect(result).toEqual(new Set(["b1", "b3"]));
  });
});

describe("buildSeenBaseline", () => {
  it("builds baseline from current members only", () => {
    const decrypted = [makeMember("user-a", ["b1"])];
    const raw = [makeRawMember("user-a", "2026-01-01T00:00:00Z")];
    const baseline = buildSeenBaseline(decrypted, raw);
    expect(Object.keys(baseline)).toEqual(["user-a"]);
    expect(baseline["user-a"]).toEqual({
      lastUpdated: "2026-01-01T00:00:00Z",
      bookIds: ["b1"],
    });
  });

  it("uses empty string when raw member has null lastUpdated", () => {
    const decrypted = [makeMember("user-a", ["b1"])];
    const raw = [makeRawMember("user-a", null)];
    expect(buildSeenBaseline(decrypted, raw)["user-a"].lastUpdated).toBe("");
  });
});
