import { describe, it, expect } from "vitest";
import {
  formatRetryDelay,
  buildRetryMessage,
  buildStaticRetryMessage,
  rateLimitedEnvelopeMessage,
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

/**
 * The envelope variant, used by the SettingsPage write paths that read
 * `res.error` instead of catching a thrown `ApiError` (save display name, leave
 * family). Those call sites used to render the Worker's English `error.message`
 * verbatim on a 429.
 */
describe("rateLimitedEnvelopeMessage", () => {
  const STATIC_COPY = "嘗試次數過多，請稍後再試。";

  it.each([
    "OWNER_CANNOT_LEAVE",
    "FORBIDDEN",
    "VERIFICATION_LOCKED",
    "INTERNAL_ERROR",
    // Matched exactly — casing is not normalized, so a lookalike code must not
    // hijack the back-off copy.
    "rate_limited",
    "",
  ])("returns null for %s so the caller keeps its own fallback", (code) => {
    expect(rateLimitedEnvelopeMessage({ code, retryAfter: 45 })).toBeNull();
  });

  it.each<[string, number | undefined]>([
    ["no retryAfter at all (older backend)", undefined],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["a negative wait", -1],
    // Unlike the Extension helper, a zero wait selects the static copy here:
    // the PWA's own `buildRetryMessage` treats <= 0 as "no countdown running",
    // so 「0 秒」 is never a wording this app shows.
    ["a zero wait", 0],
    // A sub-second wait clears the `<= 0` guard but floors to 0, so it lands on
    // the static copy as well. Drop the `Math.floor` and this row starts
    // rendering the 「0 秒」 countdown this app never shows.
    ["a sub-second wait", 0.9],
  ])(
    "falls back to the static copy when the envelope carries %s",
    (_label, retryAfter) => {
      expect(
        rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter }),
      ).toBe(STATIC_COPY);
    },
  );

  /**
   * The envelope is raw `JSON.parse` output, so a self-hosted (BYO) backend can
   * put anything in `retryAfter`. Unusable values must degrade to the static
   * copy instead of rendering 「NaN 秒」 — hence the casts: these shapes are
   * unreachable through the type, only over the wire.
   */
  it.each<[string, unknown]>([
    ["a string", "45"],
    ["a numeric-looking string", "45s"],
    ["null", null],
    ["a boolean", true],
    ["an object", { seconds: 45 }],
  ])(
    "falls back to the static copy when a BYO backend sends %s as retryAfter",
    (_label, retryAfter) => {
      expect(
        rateLimitedEnvelopeMessage({
          code: "RATE_LIMITED",
          retryAfter: retryAfter as number,
        }),
      ).toBe(STATIC_COPY);
    },
  );

  it.each<[number, string]>([
    [1, "嘗試次數過多，請於 1 秒後再試。"],
    [45, "嘗試次數過多，請於 45 秒後再試。"],
    [90, "嘗試次數過多，請於 1 分 30 秒後再試。"],
    // Fractional waits are floored, never rendered as 「90.9 秒」.
    [90.9, "嘗試次數過多，請於 1 分 30 秒後再試。"],
    [3600, "嘗試次數過多，請於 60 分 0 秒後再試。"],
  ])("renders the countdown copy for retryAfter=%s", (retryAfter, expected) => {
    expect(
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter }),
    ).toBe(expected);
  });

  it("emits exactly the wording buildRetryMessage owns (no second copy)", () => {
    expect(
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter: 45 }),
    ).toBe(buildRetryMessage("RATE_LIMITED", 45));
    expect(rateLimitedEnvelopeMessage({ code: "RATE_LIMITED" })).toBe(
      buildStaticRetryMessage("RATE_LIMITED"),
    );
  });

  it("never leaks the server's English message into the copy", () => {
    const message = rateLimitedEnvelopeMessage({
      code: "RATE_LIMITED",
      retryAfter: 45,
    });

    expect(message).not.toContain("Too many requests");
    expect(message).not.toContain("RATE_LIMITED");
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
