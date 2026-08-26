import { describe, it, expect } from "vitest";
import { isFamilyGoneError } from "@/api/auth-refresh";
import {
  FAMILY_GONE_NOTICE_FALLBACK,
  FAMILY_GONE_NOTICE_MESSAGES,
  familyGoneNoticeText,
} from "@/dialog/familyGoneNotice";

/**
 * COPY PIN (anti-drift). This file is the single place where the literal
 * family-gone banner strings are asserted. The component test
 * (tests/component/App.test.tsx → "family-gone notice banner") renders the
 * banner and compares it against `familyGoneNoticeText(...)` rather than
 * restating the copy, so a wording change fails HERE — loudly and in exactly one
 * place — instead of silently passing everywhere.
 *
 * The text is the ONLY explanation the user gets for a dialog that flipped
 * itself back to onboarding: without it the teardown reads as a bug rather than
 * as a state change the family owner caused.
 */

/** [errorCode, exact user-facing copy] — the production literals. */
const MESSAGES: Array<[string, string]> = [
  [
    "MEMBER_REMOVED",
    "你已被家庭管理者移出家庭。如要繼續使用，可重新建立或加入家庭。",
  ],
  ["FAMILY_NOT_FOUND", "家庭資料已不存在（可能已解散），已為你解除家庭綁定。"],
  ["FAMILY_FULL", "家庭成員已滿，無法重新連線，已為你解除家庭綁定。"],
];

describe("FAMILY_GONE_NOTICE_MESSAGES", () => {
  it.each(MESSAGES)("maps %s to its reason text", (code, expected) => {
    expect(FAMILY_GONE_NOTICE_MESSAGES.get(code)).toBe(expected);
  });

  it("carries exactly the three family-gone codes and nothing else", () => {
    expect([...FAMILY_GONE_NOTICE_MESSAGES.keys()]).toEqual(
      MESSAGES.map(([code]) => code),
    );
  });

  /**
   * Anti-drift against the classifier: a message keyed on a code that is NOT
   * family-gone would be unreachable copy, because both teardown entry points
   * run `isFamilyGoneError` before anything is torn down.
   *
   * Only this direction is checkable — FAMILY_GONE_ERROR_CODES stays private in
   * `api/auth-refresh.ts`, so a NEW gone code added there without a message here
   * silently falls to the generic fallback rather than failing this test.
   */
  it.each(MESSAGES.map(([code]) => code))(
    "keys %s, which the shared classifier agrees is family-gone",
    (code) => {
      expect(isFamilyGoneError(code)).toBe(true);
    },
  );
});

describe("familyGoneNoticeText", () => {
  it.each(MESSAGES)("returns the reason text for %s", (code, expected) => {
    expect(familyGoneNoticeText(code)).toBe(expected);
  });

  it("returns the fallback copy for an unmapped code", () => {
    expect(FAMILY_GONE_NOTICE_FALLBACK).toBe(
      "家庭連線已失效，已為你解除家庭綁定。",
    );
  });

  /**
   * Defense in depth: only the three codes above can arrive in practice, but an
   * unknown one must still get an explanation rather than a blank banner.
   * Casing is not normalized either — a lookalike code takes the fallback.
   */
  it.each([
    "SERVER_ERROR",
    "RATE_LIMITED",
    "VERIFICATION_REQUIRED",
    "member_removed",
    "",
  ])("falls back for %s", (code) => {
    expect(familyGoneNoticeText(code)).toBe(FAMILY_GONE_NOTICE_FALLBACK);
  });

  /**
   * The lookup key is `error.code` straight off the wire and a hostile or buggy
   * self-hosted (BYO) backend is an explicit threat model, which is why the copy
   * lives in a `Map` and not an object literal: an object literal would answer
   * these with something that is not a `string | undefined` (e.g. `toString`
   * would render a function body into the banner).
   */
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "falls back for the prototype key %s instead of leaking an inherited value",
    (code) => {
      expect(familyGoneNoticeText(code)).toBe(FAMILY_GONE_NOTICE_FALLBACK);
    },
  );

  it("never shows the raw error code to the user", () => {
    for (const [code] of MESSAGES) {
      expect(familyGoneNoticeText(code)).not.toContain(code);
    }
    expect(FAMILY_GONE_NOTICE_FALLBACK).not.toMatch(/[A-Z_]{4,}/);
  });
});
