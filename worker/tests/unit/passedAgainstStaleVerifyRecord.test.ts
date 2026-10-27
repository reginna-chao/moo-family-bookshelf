import { describe, it, expect } from "vitest";
import { passedAgainstStaleVerifyRecord } from "../../src/services/verification";
import type { AuthRecord, VerifyRecord } from "../../src/kv/schema";

/**
 * `passedAgainstStaleVerifyRecord` (#378): true when the verify record a join's
 * gate passed on predates the PIN / pattern rotation `auth.secretAt` was
 * written for — the record is absent, lacks `secretUpdatedAt`, or carries an
 * earlier one. An auth record without `secretAt` (or no auth record) never
 * trips it; equal timestamps are current.
 */

const SECRET_AT = 1_000_000;

function auth(secretAt?: unknown): AuthRecord {
  return {
    token: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(secretAt !== undefined && { secretAt: secretAt as number }),
  };
}

function verify(secretUpdatedAt?: unknown): VerifyRecord {
  return {
    method: "pin",
    hash: "h",
    salt: "s",
    prompted: 1,
    ...(secretUpdatedAt !== undefined && {
      secretUpdatedAt: secretUpdatedAt as number,
    }),
  };
}

describe("passedAgainstStaleVerifyRecord", () => {
  it.each([
    {
      label: "an older record",
      a: auth(SECRET_AT),
      v: verify(SECRET_AT - 1),
      stale: true,
    },
    { label: "no record", a: auth(SECRET_AT), v: null, stale: true },
    {
      label: "a record without secretUpdatedAt",
      a: auth(SECRET_AT),
      v: verify(),
      stale: true,
    },
    {
      label: "a non-numeric secretUpdatedAt",
      a: auth(SECRET_AT),
      v: verify(String(SECRET_AT)),
      stale: true,
    },
    {
      label: "an equal record",
      a: auth(SECRET_AT),
      v: verify(SECRET_AT),
      stale: false,
    },
    {
      label: "a newer record",
      a: auth(SECRET_AT),
      v: verify(SECRET_AT + 1),
      stale: false,
    },
    {
      label: "auth without secretAt, no record",
      a: auth(),
      v: null,
      stale: false,
    },
    {
      label: "auth with a non-numeric secretAt",
      a: auth("1"),
      v: null,
      stale: false,
    },
    { label: "no auth record", a: null, v: null, stale: false },
  ])("is $stale for $label", ({ a, v, stale }) => {
    expect(passedAgainstStaleVerifyRecord(a, v)).toBe(stale);
  });
});
