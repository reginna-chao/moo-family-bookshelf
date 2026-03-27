import { describe, it, expect } from "vitest";
import {
  encodeSyncCode,
  decodeSyncCode,
  SyncCodeError,
} from "@/crypto/syncCode";

describe("encodeSyncCode", () => {
  it("should encode without API host", () => {
    const result = encodeSyncCode({
      familyId: "abc123",
      encryptionKey: "key456",
    });
    expect(result).toBe("moo-abc123-key456");
  });

  it("should encode with API host", () => {
    const result = encodeSyncCode({
      familyId: "abc123",
      encryptionKey: "key456",
      apiHost: "my-worker.example.com",
    });
    expect(result).toBe("moo-abc123-key456@my-worker.example.com");
  });
});

describe("decodeSyncCode", () => {
  it("should decode a standard sync code", () => {
    const result = decodeSyncCode("moo-abc123-key456");
    expect(result).toEqual({
      familyId: "abc123",
      encryptionKey: "key456",
      apiHost: undefined,
    });
  });

  it("should decode a sync code with API host", () => {
    const result = decodeSyncCode("moo-abc123-key456@my-worker.example.com");
    expect(result).toEqual({
      familyId: "abc123",
      encryptionKey: "key456",
      apiHost: "my-worker.example.com",
    });
  });

  it("should handle encryption key with hyphens", () => {
    const result = decodeSyncCode("moo-abc123-key-part1-part2");
    expect(result).toEqual({
      familyId: "abc123",
      encryptionKey: "key-part1-part2",
      apiHost: undefined,
    });
  });

  it("should trim whitespace", () => {
    const result = decodeSyncCode("  moo-abc123-key456  ");
    expect(result.familyId).toBe("abc123");
  });

  it("should throw on invalid prefix", () => {
    expect(() => decodeSyncCode("foo-abc-key")).toThrow(SyncCodeError);
  });

  it("should throw on too few parts", () => {
    expect(() => decodeSyncCode("moo-abc")).toThrow(SyncCodeError);
  });

  it("should throw on empty host after @", () => {
    expect(() => decodeSyncCode("moo-abc-key@")).toThrow(SyncCodeError);
  });
});

describe("roundtrip", () => {
  it("should encode then decode back to the same data", () => {
    const original = {
      familyId: "fam99",
      encryptionKey: "superSecretKey123",
      apiHost: "custom.workers.dev",
    };
    const encoded = encodeSyncCode(original);
    const decoded = decodeSyncCode(encoded);
    expect(decoded).toEqual(original);
  });

  it("should roundtrip without API host", () => {
    const original = {
      familyId: "fam99",
      encryptionKey: "superSecretKey123",
    };
    const encoded = encodeSyncCode(original);
    const decoded = decodeSyncCode(encoded);
    expect(decoded.familyId).toBe(original.familyId);
    expect(decoded.encryptionKey).toBe(original.encryptionKey);
    expect(decoded.apiHost).toBeUndefined();
  });
});
