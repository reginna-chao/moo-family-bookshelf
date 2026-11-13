import { describe, it, expect } from "vitest";
import {
  AUTO_SYNC_INTERVALS,
  FLOATING_ICON_SIZES,
  isAutoSyncInterval,
  isFloatingIconSize,
} from "moo-family-bookshelf-shared/api/accountSettingsValues";

/**
 * The two string-valued account settings (#460) and their guards, from
 * `shared/src/api/accountSettingsValues.ts`. The Worker's PATCH boundary
 * check and both clients' response checks use these guards, so the value
 * lists are wire contract: a value dropped here makes the Worker refuse a
 * client's save with `400 INVALID_SETTINGS` and makes a client ignore the
 * stored value. `shared/` has no test script of its own; this file sits in
 * `worker-check`, whose path filter covers `shared/**`.
 *
 * The lists are pinned as literals on purpose, not derived from the exports,
 * so a value renamed or removed fails here rather than passing by
 * construction.
 */

const INTERVALS = ["daily", "weekly", "monthly", "never"];
const SIZES = ["small", "medium", "large", "icon"];

const NOT_A_MEMBER: { label: string; value: unknown }[] = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "a number", value: 1 },
  { label: "a boolean", value: true },
  { label: "an empty string", value: "" },
  { label: "an object", value: {} },
  { label: "a String object", value: Object("daily") },
  { label: "a one-element array", value: ["daily"] },
  { label: "an Object.prototype key", value: "toString" },
  { label: "a padded value", value: " weekly" },
  { label: "an uppercase value", value: "Small" },
];

describe("account-settings value lists", () => {
  it("AUTO_SYNC_INTERVALS lists the four intervals in screen order", () => {
    expect([...AUTO_SYNC_INTERVALS]).toEqual(INTERVALS);
  });

  it("FLOATING_ICON_SIZES lists the four sizes in screen order", () => {
    expect([...FLOATING_ICON_SIZES]).toEqual(SIZES);
  });
});

describe("isAutoSyncInterval", () => {
  it.each(INTERVALS)("accepts %s", (value) => {
    expect(isAutoSyncInterval(value)).toBe(true);
  });

  it.each(SIZES)("rejects the size %s", (value) => {
    expect(isAutoSyncInterval(value)).toBe(false);
  });

  it.each(NOT_A_MEMBER)("rejects $label", ({ value }) => {
    expect(isAutoSyncInterval(value)).toBe(false);
  });
});

describe("isFloatingIconSize", () => {
  it.each(SIZES)("accepts %s", (value) => {
    expect(isFloatingIconSize(value)).toBe(true);
  });

  it.each(INTERVALS)("rejects the interval %s", (value) => {
    expect(isFloatingIconSize(value)).toBe(false);
  });

  it.each(NOT_A_MEMBER)("rejects $label", ({ value }) => {
    expect(isFloatingIconSize(value)).toBe(false);
  });
});
