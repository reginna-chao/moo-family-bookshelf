import { describe, it, expect } from "vitest";
import { normalizeAuthRecord } from "../../src/services/authRecord";
import type { RawAuthRecord } from "../../src/kv/auth";

/**
 * `normalizeAuthRecord` (#425) classifies `auth:{userId}` exactly as read.
 * The #425 shape (`{ tokens, secretAt? }`) passes through with malformed list
 * entries dropped; a non-array `tokens` reads as `[]`; `secretAt` survives only
 * as a number; a pre-#425 record's string `token` surfaces as `legacyToken`
 * (its `createdAt` is dropped — a migration restarts the age from then).
 */

const HASH = "a".repeat(64);
const CREATED_AT = "2026-10-01T00:00:00.000Z";
const ENTRY = { hash: HASH, createdAt: CREATED_AT };

describe("normalizeAuthRecord", () => {
  it("keeps null as null", () => {
    expect(normalizeAuthRecord(null)).toBeNull();
  });

  it.each<{ label: string; raw: RawAuthRecord; expected: unknown }>([
    {
      label: "a #425 record passes through",
      raw: { tokens: [ENTRY], secretAt: 5 },
      expected: { tokens: [ENTRY], secretAt: 5 },
    },
    {
      label: "a non-array tokens reads as an empty list",
      raw: { tokens: "nope" },
      expected: { tokens: [] },
    },
    {
      label: "an object tokens reads as an empty list",
      raw: { tokens: { 0: ENTRY } },
      expected: { tokens: [] },
    },
    {
      label: "a record holding only secretAt keeps it",
      raw: { secretAt: 7 },
      expected: { tokens: [], secretAt: 7 },
    },
    {
      label: "entries missing hash or createdAt, or not objects, are dropped",
      raw: {
        tokens: [
          ENTRY,
          { createdAt: CREATED_AT },
          { hash: HASH },
          { hash: 1, createdAt: CREATED_AT },
          null,
          "x",
        ],
      },
      expected: { tokens: [ENTRY] },
    },
    {
      label: "extra fields on an entry are not carried",
      raw: { tokens: [{ ...ENTRY, token: "leak" }] },
      expected: { tokens: [ENTRY] },
    },
    {
      label: "a non-number secretAt is dropped",
      raw: { tokens: [], secretAt: "5" },
      expected: { tokens: [] },
    },
    {
      label: "a pre-#425 record surfaces its token as legacyToken",
      raw: { token: HASH, createdAt: CREATED_AT, secretAt: 9 },
      expected: { tokens: [], secretAt: 9, legacyToken: HASH },
    },
    {
      label: "a pre-#425 record without secretAt",
      raw: { token: HASH, createdAt: CREATED_AT },
      expected: { tokens: [], legacyToken: HASH },
    },
    {
      label: "a non-string legacy token is ignored",
      raw: { token: 42, createdAt: CREATED_AT },
      expected: { tokens: [] },
    },
  ])("$label", ({ raw, expected }) => {
    expect(normalizeAuthRecord(raw)).toStrictEqual(expected);
  });
});
