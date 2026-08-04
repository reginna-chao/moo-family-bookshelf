import { describe, it, expect } from "vitest";
import {
  formatRetryDelay,
  buildRetryMessage,
  buildStaticRetryMessage,
} from "@/utils/retryMessage";
import type { RetryErrorCode } from "@/utils/retryMessage";

describe("formatRetryDelay", () => {
  it.each([
    [0, "0 秒"],
    [1, "1 秒"],
    [30, "30 秒"],
    [59, "59 秒"],
    [60, "1 分 0 秒"],
    [61, "1 分 1 秒"],
    [90, "1 分 30 秒"],
    [119, "1 分 59 秒"],
    [120, "2 分 0 秒"],
    [600, "10 分 0 秒"],
    [3661, "61 分 1 秒"],
  ])("formats %i seconds as '%s'", (seconds, expected) => {
    expect(formatRetryDelay(seconds)).toBe(expected);
  });

  it.each([
    [0.9, "0 秒"],
    [59.9, "59 秒"],
    [60.5, "1 分 0 秒"],
  ])("floors the fractional input %f to '%s'", (seconds, expected) => {
    expect(formatRetryDelay(seconds)).toBe(expected);
  });

  it.each([[-1], [-90]])("normalizes the negative input %i to '0 秒'", (s) => {
    expect(formatRetryDelay(s)).toBe("0 秒");
  });
});

describe("buildRetryMessage", () => {
  // Production copy is pinned here (anti-drift): component tests assert against
  // buildRetryMessage() output, so this suite is the single source of truth for
  // the literal strings shown to the user.
  it("returns the static lockout copy when no countdown is running", () => {
    expect(buildRetryMessage("VERIFICATION_LOCKED", 0)).toBe(
      "驗證錯誤次數過多，請稍後再試。",
    );
  });

  it("returns the static rate-limit copy when no countdown is running", () => {
    expect(buildRetryMessage("RATE_LIMITED", 0)).toBe(
      "嘗試次數過多，請稍後再試。",
    );
  });

  it("returns the lockout countdown copy with a minutes-and-seconds delay", () => {
    expect(buildRetryMessage("VERIFICATION_LOCKED", 90)).toBe(
      "驗證錯誤次數過多，請於 1 分 30 秒後再試。",
    );
  });

  it("returns the rate-limit countdown copy with a seconds-only delay", () => {
    expect(buildRetryMessage("RATE_LIMITED", 30)).toBe(
      "嘗試次數過多，請於 30 秒後再試。",
    );
  });

  const codes: RetryErrorCode[] = ["VERIFICATION_LOCKED", "RATE_LIMITED"];

  it.each(codes)(
    "falls back to the static copy for %s when remaining is negative",
    (code) => {
      expect(buildRetryMessage(code, -5)).toBe(buildRetryMessage(code, 0));
    },
  );

  it.each(codes)(
    "embeds the formatted delay in the countdown copy for %s",
    (code) => {
      const message = buildRetryMessage(code, 125);

      expect(message).toContain(formatRetryDelay(125));
      expect(message).not.toBe(buildRetryMessage(code, 0));
    },
  );

  it.each(codes)("uses distinct static and countdown copy for %s", (code) => {
    expect(buildRetryMessage(code, 1)).not.toBe(buildRetryMessage(code, 0));
  });

  it("uses different copy for the two error codes", () => {
    expect(buildRetryMessage("VERIFICATION_LOCKED", 45)).not.toBe(
      buildRetryMessage("RATE_LIMITED", 45),
    );
  });
});

describe("buildStaticRetryMessage", () => {
  // The sentence announced to assistive tech: it must never carry a countdown,
  // otherwise a screen reader re-announces it once per second.
  it.each<[RetryErrorCode, string]>([
    ["VERIFICATION_LOCKED", "驗證錯誤次數過多，請稍後再試。"],
    ["RATE_LIMITED", "嘗試次數過多，請稍後再試。"],
  ])("returns the countdown-free copy for %s", (code, expected) => {
    expect(buildStaticRetryMessage(code)).toBe(expected);
  });

  const codes: RetryErrorCode[] = ["VERIFICATION_LOCKED", "RATE_LIMITED"];

  it.each(codes)(
    "matches the no-countdown variant of buildRetryMessage for %s",
    (code) => {
      expect(buildStaticRetryMessage(code)).toBe(buildRetryMessage(code, 0));
    },
  );

  it.each(codes)("stays identical across remaining values for %s", (code) => {
    const announced = buildStaticRetryMessage(code);

    for (const remaining of [1, 45, 90, 3600]) {
      expect(buildStaticRetryMessage(code)).toBe(announced);
      expect(buildRetryMessage(code, remaining)).not.toBe(announced);
    }
  });
});
