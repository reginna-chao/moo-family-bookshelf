import { describe, it, expect } from "vitest";
import {
  DERIVED_STEP_UP_BUCKET,
  isQrBoundToListedToken,
  stepUpBudgetBucket,
} from "../../src/services/authRecord";
import { BoolFlag, type AuthRecord } from "../../src/kv/schema";

/**
 * The two pure rules that read a token's entry in `auth:{userId}`.
 *
 * `isQrBoundToListedToken`: a QR skips verification only while the list names the
 * token that minted it, on an entry without the `derived` mark. `stepUpBudgetBucket`:
 * a listed unmarked token spends its own step-up budget, named by its hash; every
 * other bearer (marked, off the list, no record, empty list, no hash) spends the
 * one shared bucket. Each row keeps a second entry on the list, so a rule that
 * looked at the wrong entry would answer differently.
 */

const CREATED_AT = "2026-10-01T00:00:00.000Z";
const UNMARKED = "a".repeat(64);
const MARKED = "b".repeat(64);
const OFF_THE_LIST = "c".repeat(64);
const AUTH: AuthRecord = {
  tokens: [
    { hash: UNMARKED, createdAt: CREATED_AT },
    { hash: MARKED, createdAt: CREATED_AT, derived: BoolFlag.TRUE },
  ],
};
const EMPTY: AuthRecord = { tokens: [] };

describe("isQrBoundToListedToken", () => {
  it.each<{
    label: string;
    hash: string | undefined;
    auth: AuthRecord | null;
    bound: boolean;
  }>([
    {
      label: "a listed unmarked token",
      hash: UNMARKED,
      auth: AUTH,
      bound: true,
    },
    { label: "a listed marked token", hash: MARKED, auth: AUTH, bound: false },
    {
      label: "a token off the list",
      hash: OFF_THE_LIST,
      auth: AUTH,
      bound: false,
    },
    { label: "no token hash", hash: undefined, auth: AUTH, bound: false },
    { label: "no auth: record", hash: UNMARKED, auth: null, bound: false },
    { label: "an empty list", hash: UNMARKED, auth: EMPTY, bound: false },
  ])("answers $bound for $label", ({ hash, auth, bound }) => {
    expect(isQrBoundToListedToken(hash, auth)).toBe(bound);
  });
});

describe("stepUpBudgetBucket", () => {
  it.each<{
    label: string;
    auth: AuthRecord | null;
    hash: string | null;
    bucket: string;
  }>([
    {
      label: "a listed unmarked token",
      auth: AUTH,
      hash: UNMARKED,
      bucket: UNMARKED,
    },
    {
      label: "a listed marked token",
      auth: AUTH,
      hash: MARKED,
      bucket: DERIVED_STEP_UP_BUCKET,
    },
    {
      label: "a token off the list",
      auth: AUTH,
      hash: OFF_THE_LIST,
      bucket: DERIVED_STEP_UP_BUCKET,
    },
    {
      label: "no auth: record",
      auth: null,
      hash: UNMARKED,
      bucket: DERIVED_STEP_UP_BUCKET,
    },
    {
      label: "an empty list",
      auth: EMPTY,
      hash: UNMARKED,
      bucket: DERIVED_STEP_UP_BUCKET,
    },
    {
      label: "no presented hash",
      auth: AUTH,
      hash: null,
      bucket: DERIVED_STEP_UP_BUCKET,
    },
  ])("names $bucket for $label", ({ auth, hash, bucket }) => {
    expect(stepUpBudgetBucket(auth, hash)).toBe(bucket);
  });

  it("names the shared bucket distinctly from any token hash", () => {
    expect(DERIVED_STEP_UP_BUCKET).toBe("derived");
    expect(DERIVED_STEP_UP_BUCKET).not.toMatch(/^[a-f0-9]{64}$/);
  });
});
