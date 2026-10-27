import { describe, it, expect } from "vitest";
import {
  isPatternComplete,
  isPinComplete,
  normalizePinInput,
  pickSecretEntryError,
  PATTERN_MIN_DOTS,
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  serializePattern,
} from "moo-family-bookshelf-shared/verifyInput/rules";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretPrompt,
  currentSecretWrongMessage,
  formatPatternCounter,
  formatPinCounter,
  PATTERN_MISMATCH_MESSAGE,
  PIN_MISMATCH_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";

/**
 * Input rules and copy of the PIN / pattern secret-entry widgets, shared by the Extension Dialog and
 * the PWA (#385). `shared/` has no test script of its own, so this file is the single unit cover;
 * the PWA side does not duplicate it.
 *
 * This is the production-anchored pin for the two mismatch sentences and the two counter formats
 * (`.claude/rules/test.md` → Anti-Drift). The twin `PinInput` / `PatternLock` component suites of
 * both apps assert the same literals through the render sites.
 *
 * `serializePattern` is the wire format the Worker hashes: a change to the separator or spacing
 * makes every stored pattern stop matching, so its exact output is pinned here.
 */

describe("verifyInput rules constants", () => {
  it("pins the PIN length bounds and the pattern minimum", () => {
    expect(PIN_MIN_LENGTH).toBe(6);
    expect(PIN_MAX_LENGTH).toBe(12);
    expect(PATTERN_MIN_DOTS).toBe(4);
  });
});

describe("normalizePinInput", () => {
  it.each([
    { raw: "", expected: "" },
    { raw: "123456", expected: "123456" },
    { raw: "abc123", expected: "123" },
    { raw: "12a345", expected: "12345" },
    { raw: " 12-34 ", expected: "1234" },
    { raw: "abc", expected: "" },
    { raw: "１２３", expected: "" },
    { raw: "123456789012", expected: "123456789012" },
    { raw: "12345678901a2", expected: "123456789012" },
    { raw: "1234567890123", expected: null },
    { raw: "a1234567890123", expected: null },
  ])("normalizes $raw to $expected", ({ raw, expected }) => {
    expect(normalizePinInput(raw)).toBe(expected);
  });
});

describe("isPinComplete", () => {
  it.each([
    { pin: "", expected: false },
    { pin: "12345", expected: false },
    { pin: "123456", expected: true },
    { pin: "123456789012", expected: true },
  ])("returns $expected for a $pin.length-digit PIN", ({ pin, expected }) => {
    expect(isPinComplete(pin)).toBe(expected);
  });
});

describe("isPatternComplete", () => {
  it.each([
    { dots: [], expected: false },
    { dots: [0, 1, 2], expected: false },
    { dots: [0, 1, 2, 5], expected: true },
    { dots: [0, 1, 2, 5, 8, 7, 6, 3, 4], expected: true },
  ])(
    "returns $expected for $dots.length connected dots",
    ({ dots, expected }) => {
      expect(isPatternComplete(dots)).toBe(expected);
    },
  );
});

describe("serializePattern", () => {
  it("joins the dot indices with bare commas (the hashed wire format)", () => {
    expect(serializePattern([0, 1, 2, 5])).toBe("0,1,2,5");
  });

  it("keeps the drawing order rather than sorting", () => {
    expect(serializePattern([8, 4, 0, 3])).toBe("8,4,0,3");
  });

  it("serializes an empty pattern to an empty string", () => {
    expect(serializePattern([])).toBe("");
  });
});

describe("pickSecretEntryError", () => {
  it.each([
    { local: "本地錯誤", external: "伺服器錯誤", expected: "本地錯誤" },
    { local: "本地錯誤", external: undefined, expected: "本地錯誤" },
    { local: "", external: "伺服器錯誤", expected: "伺服器錯誤" },
    { local: "", external: "", expected: "" },
    { local: "", external: undefined, expected: "" },
  ])(
    "picks $expected from local $local and external $external",
    ({ local, external, expected }) => {
      expect(pickSecretEntryError(local, external)).toBe(expected);
    },
  );
});

describe("verifyInput messages", () => {
  it("pins the PIN mismatch sentence", () => {
    expect(PIN_MISMATCH_MESSAGE).toBe("兩次輸入的 PIN 碼不一致，請重新輸入。");
  });

  it("pins the pattern mismatch sentence", () => {
    expect(PATTERN_MISMATCH_MESSAGE).toBe("兩次圖形不一致，請重新繪製。");
  });

  it.each([
    { length: 0, expected: "0/6-12 位" },
    { length: 5, expected: "5/6-12 位" },
    { length: 12, expected: "12/6-12 位" },
  ])("formats the PIN counter for $length digits", ({ length, expected }) => {
    expect(formatPinCounter(length)).toBe(expected);
  });

  it.each([
    { count: 0, expected: "已連接 0 個點（最少 4 個）" },
    { count: 3, expected: "已連接 3 個點（最少 4 個）" },
    { count: 9, expected: "已連接 9 個點（最少 4 個）" },
  ])("formats the pattern counter for $count dots", ({ count, expected }) => {
    expect(formatPatternCounter(count)).toBe(expected);
  });
});

/** Copy of the current-secret step before a verify change or account deletion (#396); the render
 *  sites are asserted in VerificationSettings.stepUp / FamilySettingsDeleteBlock component suites. */
describe("current-secret messages", () => {
  it("pins the wrong-secret and unavailable sentences", () => {
    expect(CURRENT_PIN_WRONG_MESSAGE).toBe("目前的 PIN 碼不正確，請重新輸入。");
    expect(CURRENT_PATTERN_WRONG_MESSAGE).toBe(
      "目前的圖形不正確，請重新繪製。",
    );
    expect(CURRENT_SECRET_UNAVAILABLE_MESSAGE).toBe(
      "伺服器要求驗證目前的 PIN 碼或圖形，請稍後再試。",
    );
  });

  it.each([
    { method: "pin", expected: CURRENT_PIN_WRONG_MESSAGE },
    { method: "pattern", expected: CURRENT_PATTERN_WRONG_MESSAGE },
  ] as const)(
    "picks the wrong-secret copy for $method",
    ({ method, expected }) => {
      expect(currentSecretWrongMessage(method)).toBe(expected);
    },
  );

  it.each([
    {
      method: "pin",
      purpose: "change",
      expected: "要更改登入驗證，請先輸入目前的 PIN 碼。",
    },
    {
      method: "pattern",
      purpose: "change",
      expected: "要更改登入驗證，請先畫出目前的圖形。",
    },
    {
      method: "pin",
      purpose: "delete",
      expected: "移除帳戶前，請先輸入目前的 PIN 碼。",
    },
    {
      method: "pattern",
      purpose: "delete",
      expected: "移除帳戶前，請先畫出目前的圖形。",
    },
  ] as const)(
    "builds the $purpose prompt for $method",
    ({ method, purpose, expected }) => {
      expect(currentSecretPrompt(method, purpose)).toBe(expected);
    },
  );
});
