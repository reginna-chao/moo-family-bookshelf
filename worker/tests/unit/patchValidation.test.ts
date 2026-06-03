import { describe, it, expect } from "vitest";
import { parsePatchChanges, validatePatchDisplayName } from "../../src/routes/user";

// ---------------------------------------------------------------------------
// parsePatchChanges
// ---------------------------------------------------------------------------

describe("parsePatchChanges", () => {
  // --- Error cases (table-driven) ---

  it.each<{ label: string; body: Record<string, unknown>; max: number; message: string }>([
    { label: "changes missing", body: {}, max: 1000, message: "changes array is required" },
    { label: "changes not an array", body: { changes: "oops" }, max: 1000, message: "changes array is required" },
    { label: "changes empty array", body: { changes: [] }, max: 1000, message: "changes array must not be empty" },
    {
      label: "changes exceeds maxChanges",
      body: { changes: [{ bookId: "b1", isShared: 0 }, { bookId: "b2", isShared: 1 }, { bookId: "b3", isShared: 0 }] },
      max: 2,
      message: "changes array exceeds maximum of 2",
    },
    { label: "entry is not an object (number)", body: { changes: [42] }, max: 1000, message: "Each change must be an object with bookId and isShared" },
    { label: "entry is null", body: { changes: [null] }, max: 1000, message: "Each change must be an object with bookId and isShared" },
    { label: "bookId is empty string", body: { changes: [{ bookId: "", isShared: 1 }] }, max: 1000, message: "bookId must be a non-empty string" },
    { label: "bookId is non-string (number)", body: { changes: [{ bookId: 123, isShared: 1 }] }, max: 1000, message: "bookId must be a non-empty string" },
    { label: "isShared is 2", body: { changes: [{ bookId: "b1", isShared: 2 }] }, max: 1000, message: "isShared must be 0 or 1" },
    { label: "isShared is string", body: { changes: [{ bookId: "b1", isShared: "yes" }] }, max: 1000, message: "isShared must be 0 or 1" },
  ])("returns error when $label", ({ body, max, message }) => {
    const result = parsePatchChanges(body, max);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toBe(message);
    }
  });

  // --- Success cases ---

  it("returns changeMap for a single valid entry", () => {
    const result = parsePatchChanges({ changes: [{ bookId: "b1", isShared: 1 }] }, 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changeMap.size).toBe(1);
      expect(result.changeMap.get("b1")).toBe(1);
    }
  });

  it("returns changeMap for multiple valid entries", () => {
    const result = parsePatchChanges({
      changes: [
        { bookId: "b1", isShared: 0 },
        { bookId: "b2", isShared: 1 },
      ],
    }, 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changeMap.size).toBe(2);
      expect(result.changeMap.get("b1")).toBe(0);
      expect(result.changeMap.get("b2")).toBe(1);
    }
  });

  it("accepts exactly maxChanges entries (boundary)", () => {
    const result = parsePatchChanges({
      changes: [
        { bookId: "b1", isShared: 0 },
        { bookId: "b2", isShared: 1 },
      ],
    }, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changeMap.size).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// validatePatchDisplayName
// ---------------------------------------------------------------------------

describe("validatePatchDisplayName", () => {
  it("returns ok when displayName is absent", () => {
    expect(validatePatchDisplayName({})).toEqual({ ok: true });
  });

  it("returns ok when displayName is a valid string", () => {
    expect(validatePatchDisplayName({ displayName: "Alice" })).toEqual({ ok: true });
  });

  it("returns error when displayName is empty string", () => {
    const result = validatePatchDisplayName({ displayName: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toBe("displayName must not be empty string");
    }
  });

  it("returns error when displayName is non-string (number)", () => {
    const result = validatePatchDisplayName({ displayName: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toBe("displayName is invalid");
    }
  });
});
