import { describe, it, expect } from "vitest";
import { isValidFamilyPrefRef } from "../../src/utils/validation";
import { parseFamilyPrefs } from "../../src/routes/user";

// A canonical 64-char lowercase SHA-256 hex ownerId for building valid refs.
const OWNER = "a".repeat(64);
const ref = (bookId: string, owner = OWNER) => `${owner}:${bookId}`;

// ---------------------------------------------------------------------------
// isValidFamilyPrefRef
// ---------------------------------------------------------------------------

describe("isValidFamilyPrefRef", () => {
  it("accepts exactly 64 lowercase hex + ':' + non-empty bookId", () => {
    expect(isValidFamilyPrefRef(ref("b1"))).toBe(true);
    expect(isValidFamilyPrefRef(ref("210034"))).toBe(true);
    // bookId may itself contain a colon — the regex only anchors the owner part.
    expect(isValidFamilyPrefRef(ref("book:with:colons"))).toBe(true);
    // full hex alphabet 0-9a-f
    expect(isValidFamilyPrefRef(ref("x", "0123456789abcdef".repeat(4)))).toBe(true);
  });

  it.each<{ label: string; value: string }>([
    { label: "uppercase hex ownerId", value: ref("b1", "A".repeat(64)) },
    { label: "ownerId one char too short (63)", value: ref("b1", "a".repeat(63)) },
    { label: "ownerId one char too long (65)", value: ref("b1", "a".repeat(65)) },
    { label: "missing ':' separator", value: `${OWNER}b1` },
    { label: "empty bookId after ':'", value: `${OWNER}:` },
    { label: "non-hex char in ownerId (g)", value: ref("b1", "g".repeat(64)) },
    { label: "empty string", value: "" },
    { label: "only the ownerId, no colon", value: OWNER },
  ])("rejects $label", ({ value }) => {
    expect(isValidFamilyPrefRef(value)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseFamilyPrefs
// ---------------------------------------------------------------------------

describe("parseFamilyPrefs", () => {
  // --- Success cases ---

  it("passes valid entries through unchanged", () => {
    const result = parseFamilyPrefs({ hidden: [ref("b1"), ref("b2")] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hidden).toEqual([ref("b1"), ref("b2")]);
    }
  });

  it("dedupes duplicates preserving first-seen order", () => {
    const result = parseFamilyPrefs(
      { hidden: [ref("b1"), ref("b2"), ref("b1"), ref("b3"), ref("b2")] },
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hidden).toEqual([ref("b1"), ref("b2"), ref("b3")]);
    }
  });

  it("accepts an empty array → ok with hidden:[]", () => {
    const result = parseFamilyPrefs({ hidden: [] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hidden).toEqual([]);
    }
  });

  it("accepts exactly max entries (boundary)", () => {
    const hidden = [ref("b1"), ref("b2"), ref("b3")];
    const result = parseFamilyPrefs({ hidden }, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hidden).toEqual(hidden);
    }
  });

  it("enforces max AFTER dedupe (duplicates do not count toward the limit)", () => {
    // 4 raw entries but only 2 unique → ok even with max 2.
    const result = parseFamilyPrefs(
      { hidden: [ref("b1"), ref("b1"), ref("b2"), ref("b2")] },
      2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hidden).toEqual([ref("b1"), ref("b2")]);
    }
  });

  // --- Error cases (table-driven) ---

  it.each<{ label: string; body: Record<string, unknown>; max: number }>([
    { label: "exceeds max after dedupe", body: { hidden: [ref("b1"), ref("b2"), ref("b3")] }, max: 2 },
    { label: "hidden missing", body: {}, max: 100 },
    { label: "hidden is an object", body: { hidden: { foo: "bar" } }, max: 100 },
    { label: "hidden is a string", body: { hidden: "not-array" }, max: 100 },
    { label: "hidden is a number", body: { hidden: 42 }, max: 100 },
    { label: "an entry is a number (non-string)", body: { hidden: [123] }, max: 100 },
    { label: "an entry fails isValidFamilyPrefRef (bad ref)", body: { hidden: ["not-a-valid-ref"] }, max: 100 },
    { label: "an entry has empty bookId", body: { hidden: [`${OWNER}:`] }, max: 100 },
  ])("returns INVALID_PAYLOAD when $label", ({ body, max }) => {
    const result = parseFamilyPrefs(body, max);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(typeof result.message).toBe("string");
    }
  });

  it("reports the max in the over-limit error message", () => {
    const result = parseFamilyPrefs({ hidden: [ref("b1"), ref("b2"), ref("b3")] }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("hidden array exceeds maximum of 2 entries");
    }
  });
});
