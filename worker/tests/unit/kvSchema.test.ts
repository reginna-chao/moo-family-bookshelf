import { describe, it, expect } from "vitest";
import { kvKeys, normalizeFamilyRecord } from "../../src/kv/schema";

describe("kvKeys", () => {
  it("should generate user key", () => {
    expect(kvKeys.user("abc123")).toBe("user:abc123");
  });

  it("should generate family key", () => {
    expect(kvKeys.family("fam-001")).toBe("family:fam-001");
  });

  it("should generate member key", () => {
    expect(kvKeys.member("user1")).toBe("member:user1");
  });
});

describe("normalizeFamilyRecord", () => {
  it("should throw for corrupted record with empty members array", () => {
    const corrupted = {
      familyId: "abcd-1234",
      members: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      keyFingerprint: "a".repeat(64),
    };
    expect(() => normalizeFamilyRecord(corrupted)).toThrow(
      "Corrupted family record: members array is empty",
    );
  });

  it("should handle legacy record where first member is a string", () => {
    // Legacy format: members could be string[] instead of FamilyMember[]
    const legacy = {
      familyId: "abcd-1234",
      members: ["alice"] as unknown as { userId: string; displayName: string }[],
      createdAt: "2025-01-01T00:00:00.000Z",
      keyFingerprint: "a".repeat(64),
    };
    const result = normalizeFamilyRecord(legacy);
    // When ownerId is missing and first member is a string, ownerId falls back to that string
    expect(result.ownerId).toBe("alice");
    expect(result.maxMembers).toBe(2);
  });
});
