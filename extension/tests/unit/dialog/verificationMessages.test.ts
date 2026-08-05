import { describe, it, expect } from "vitest";
import {
  formatWaitDuration,
  rateLimitedMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";

/**
 * COPY PIN (anti-drift). This file is the single place where the literal
 * user-facing wait / lockout strings are asserted. Component tests
 * (VerificationPrompt / Onboarding / useReauth) assert against the imported
 * functions instead of restating the copy, so a wording change fails HERE —
 * loudly and in exactly one place — rather than silently passing everywhere.
 */

describe("formatWaitDuration", () => {
  it.each([
    // [totalSeconds, expected]
    [0, "0 秒"],
    [1, "1 秒"],
    [45, "45 秒"],
    // Boundary: 59 stays in seconds, 60 flips to the 分/秒 form.
    [59, "59 秒"],
    [60, "1 分 0 秒"],
    [61, "1 分 1 秒"],
    [90, "1 分 30 秒"],
    // Exact minutes keep the trailing "0 秒" (never bare 「2 分」).
    [120, "2 分 0 秒"],
    [3599, "59 分 59 秒"],
    [3600, "60 分 0 秒"],
  ])("formats %i seconds as %s", (totalSeconds, expected) => {
    expect(formatWaitDuration(totalSeconds)).toBe(expected);
  });

  it.each([
    // Defensive input from an untrusted backend field: floored, clamped at 0.
    [59.9, "59 秒"],
    [60.4, "1 分 0 秒"],
    [-1, "0 秒"],
    [-600, "0 秒"],
  ])("normalizes the out-of-range input %s to %s", (totalSeconds, expected) => {
    expect(formatWaitDuration(totalSeconds)).toBe(expected);
  });
});

describe("rateLimitedMessage", () => {
  it("returns the static copy when no countdown is available", () => {
    expect(rateLimitedMessage(null)).toBe("嘗試次數過多，請稍後再試");
  });

  it.each([
    [45, "嘗試次數過多，請於 45 秒後再試"],
    [90, "嘗試次數過多，請於 1 分 30 秒後再試"],
    [120, "嘗試次數過多，請於 2 分 0 秒後再試"],
  ])("returns the countdown copy for %i seconds", (seconds, expected) => {
    expect(rateLimitedMessage(seconds)).toBe(expected);
  });

  it("uses the countdown copy for 0 (only null selects the static wording)", () => {
    expect(rateLimitedMessage(0)).toBe("嘗試次數過多，請於 0 秒後再試");
  });
});

describe("verificationLockedMessage", () => {
  it("returns the static copy when no countdown is available", () => {
    // Wording changed from the old 「驗證已鎖定，請稍後再試」: the user is told
    // WHY they are blocked (too many wrong attempts), not the internal state.
    expect(verificationLockedMessage(null)).toBe(
      "驗證錯誤次數過多，請稍後再試",
    );
  });

  it.each([
    [30, "驗證錯誤次數過多，請於 30 秒後再試"],
    [90, "驗證錯誤次數過多，請於 1 分 30 秒後再試"],
    [120, "驗證錯誤次數過多，請於 2 分 0 秒後再試"],
  ])("returns the countdown copy for %i seconds", (seconds, expected) => {
    expect(verificationLockedMessage(seconds)).toBe(expected);
  });

  it("never appends a trailing 。 (matches the rest of the prompt copy)", () => {
    expect(verificationLockedMessage(null).endsWith("。")).toBe(false);
    expect(verificationLockedMessage(90).endsWith("。")).toBe(false);
    expect(rateLimitedMessage(null).endsWith("。")).toBe(false);
    expect(rateLimitedMessage(90).endsWith("。")).toBe(false);
  });
});
