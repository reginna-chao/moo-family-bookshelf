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
  // --- Success cases: hidden ---

  it("passes valid hidden entries through unchanged (favorites omitted when absent)", () => {
    const result = parseFamilyPrefs({ hidden: [ref("b1"), ref("b2")] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual([ref("b1"), ref("b2")]);
      // Absent kinds are omitted (handler preserves their existing KV value).
      expect("favorites" in result.prefs).toBe(false);
    }
  });

  it("dedupes duplicates preserving first-seen order", () => {
    const result = parseFamilyPrefs(
      { hidden: [ref("b1"), ref("b2"), ref("b1"), ref("b3"), ref("b2")] },
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual([ref("b1"), ref("b2"), ref("b3")]);
    }
  });

  it("accepts an empty hidden array → ok with prefs.hidden:[]", () => {
    const result = parseFamilyPrefs({ hidden: [] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual([]);
    }
  });

  it("accepts exactly max entries (boundary)", () => {
    const hidden = [ref("b1"), ref("b2"), ref("b3")];
    const result = parseFamilyPrefs({ hidden }, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual(hidden);
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
      expect(result.prefs.hidden).toEqual([ref("b1"), ref("b2")]);
    }
  });

  // --- Success cases: favorites (Wave F) ---

  it("accepts a favorites-only body (hidden omitted when absent)", () => {
    const result = parseFamilyPrefs({ favorites: [ref("b1"), ref("b2")] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.favorites).toEqual([ref("b1"), ref("b2")]);
      expect("hidden" in result.prefs).toBe(false);
    }
  });

  it("accepts an empty favorites array → ok with prefs.favorites:[]", () => {
    const result = parseFamilyPrefs({ favorites: [] }, 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.favorites).toEqual([]);
    }
  });

  it("dedupes within favorites preserving first-seen order", () => {
    const result = parseFamilyPrefs(
      { favorites: [ref("b1"), ref("b2"), ref("b1"), ref("b3"), ref("b2")] },
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.favorites).toEqual([ref("b1"), ref("b2"), ref("b3")]);
    }
  });

  // --- Success cases: both kinds ---

  it("accepts both kinds present and returns both in prefs", () => {
    const result = parseFamilyPrefs(
      { hidden: [ref("h1")], favorites: [ref("f1"), ref("f2")] },
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual([ref("h1")]);
      expect(result.prefs.favorites).toEqual([ref("f1"), ref("f2")]);
    }
  });

  it("dedupes each kind independently (a ref may appear in both lists)", () => {
    // The same ref in hidden and favorites is not cross-deduped: each list is
    // its own scope.
    const result = parseFamilyPrefs(
      { hidden: [ref("b1"), ref("b1")], favorites: [ref("b1")] },
      100,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prefs.hidden).toEqual([ref("b1")]);
      expect(result.prefs.favorites).toEqual([ref("b1")]);
    }
  });

  // --- Error cases (table-driven) ---

  it.each<{ label: string; body: Record<string, unknown>; max: number }>([
    { label: "neither hidden nor favorites present", body: {}, max: 100 },
    { label: "hidden exceeds max after dedupe", body: { hidden: [ref("b1"), ref("b2"), ref("b3")] }, max: 2 },
    { label: "hidden is an object", body: { hidden: { foo: "bar" } }, max: 100 },
    { label: "hidden is a string", body: { hidden: "not-array" }, max: 100 },
    { label: "hidden is a number", body: { hidden: 42 }, max: 100 },
    { label: "a hidden entry is a number (non-string)", body: { hidden: [123] }, max: 100 },
    { label: "a hidden entry fails isValidFamilyPrefRef (bad ref)", body: { hidden: ["not-a-valid-ref"] }, max: 100 },
    { label: "a hidden entry has empty bookId", body: { hidden: [`${OWNER}:`] }, max: 100 },
    { label: "favorites is a non-array (object)", body: { favorites: { foo: "bar" } }, max: 100 },
    { label: "favorites is a string", body: { favorites: "not-array" }, max: 100 },
    { label: "favorites is a number", body: { favorites: 42 }, max: 100 },
    { label: "a favorites entry is a number (non-string)", body: { favorites: [123] }, max: 100 },
    { label: "a favorites entry fails isValidFamilyPrefRef (bad ref)", body: { favorites: ["not-a-valid-ref"] }, max: 100 },
    { label: "favorites exceeds max after dedupe", body: { favorites: [ref("b1"), ref("b2"), ref("b3")] }, max: 2 },
    { label: "both present but favorites invalid", body: { hidden: [ref("b1")], favorites: [123] }, max: 100 },
  ])("returns INVALID_PAYLOAD when $label", ({ body, max }) => {
    const result = parseFamilyPrefs(body, max);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(typeof result.message).toBe("string");
    }
  });

  it("uses the at-least-one message when neither kind is present", () => {
    const result = parseFamilyPrefs({}, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("at least one of hidden/favorites array is required");
    }
  });

  it("caps hidden and favorites independently (hidden ok, favorites over)", () => {
    // hidden is within the max, favorites exceeds it → whole request fails.
    const result = parseFamilyPrefs(
      { hidden: [ref("h1")], favorites: [ref("f1"), ref("f2"), ref("f3")] },
      2,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("favorites array exceeds maximum of 2 entries");
    }
  });

  it("reports the max and kind in the over-limit error message (hidden)", () => {
    const result = parseFamilyPrefs({ hidden: [ref("b1"), ref("b2"), ref("b3")] }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("hidden array exceeds maximum of 2 entries");
    }
  });

  it("reports the max and kind in the over-limit error message (favorites)", () => {
    const result = parseFamilyPrefs({ favorites: [ref("b1"), ref("b2"), ref("b3")] }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("favorites array exceeds maximum of 2 entries");
    }
  });

  // --- Non-object body guard (PR #60 WARNING 1 regression) ---
  //
  // The param is typed `unknown`; a truthy primitive or array must NOT reach
  // `kind in body` (which would throw a TypeError → 500). Instead the top guard
  // returns a clean INVALID_PAYLOAD with a stable message.
  it.each<{ label: string; body: unknown }>([
    { label: "a number", body: 5 },
    { label: "a boolean", body: true },
    { label: "a string", body: "x" },
    { label: "an array", body: [ref("b1")] },
  ])("returns INVALID_PAYLOAD 'must be a JSON object' for $label", ({ body }) => {
    // The production param is `unknown`; cast satisfies the signature while
    // deliberately passing a non-object value.
    const result = parseFamilyPrefs(body as never, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_PAYLOAD");
      expect(result.message).toBe("request body must be a JSON object");
    }
  });
});
