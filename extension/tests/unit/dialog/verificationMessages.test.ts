import { describe, it, expect } from "vitest";
import { ApiError } from "@/api/types";
import {
  formatWaitDuration,
  rateLimitedEnvelopeMessage,
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

/**
 * The envelope variant, used by every family-write call site that reads
 * `response.error` instead of catching a thrown `ApiError` (leave family,
 * remove member, transfer ownership, save display name). Those call sites used
 * to render the Worker's English `error.message` verbatim on a 429.
 */
describe("rateLimitedEnvelopeMessage", () => {
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
    ["a large negative wait", -600],
  ])(
    "falls back to the static copy when the envelope carries %s",
    (_label, retryAfter) => {
      expect(
        rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter }),
      ).toBe("嘗試次數過多，請稍後再試");
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
      ).toBe("嘗試次數過多，請稍後再試");
    },
  );

  it.each<[number, string]>([
    [45, "嘗試次數過多，請於 45 秒後再試"],
    [59, "嘗試次數過多，請於 59 秒後再試"],
    [90, "嘗試次數過多，請於 1 分 30 秒後再試"],
    // Fractional waits are floored, never rendered as 「90.9 秒」.
    [90.9, "嘗試次數過多，請於 1 分 30 秒後再試"],
    [0.9, "嘗試次數過多，請於 0 秒後再試"],
    [3600, "嘗試次數過多，請於 60 分 0 秒後再試"],
  ])("renders the countdown copy for retryAfter=%s", (retryAfter, expected) => {
    expect(
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter }),
    ).toBe(expected);
  });

  it("keeps the countdown copy for retryAfter 0 (Extension semantics)", () => {
    // Deliberate divergence from the PWA helper, which flips 0 to its static
    // copy. Here 0 is a legitimate wait: `rateLimitedMessage` formats any
    // non-negative number, and the envelope path keeps that contract instead of
    // adding a second "what counts as no wait" rule. (The live countdown never
    // reaches this value — `useRetryCountdown` clears at <= 0 — so 「0 秒」 only
    // ever comes from a server-sent retryAfter.) Pinned by
    // pwa/tests/unit/retryMessage.test.ts on the other side.
    expect(
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter: 0 }),
    ).toBe("嘗試次數過多，請於 0 秒後再試");
  });

  it("emits exactly the wording rateLimitedMessage owns (no second copy)", () => {
    expect(
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter: 45 }),
    ).toBe(rateLimitedMessage(45));
    expect(rateLimitedEnvelopeMessage({ code: "RATE_LIMITED" })).toBe(
      rateLimitedMessage(null),
    );
  });

  it("accepts a thrown ApiError unchanged (structural parameter)", () => {
    // MemberList's canLend / readmooName writes throw instead of returning an
    // envelope, and hand the ApiError straight to this helper.
    expect(
      rateLimitedEnvelopeMessage(
        new ApiError("RATE_LIMITED", "Too many requests", 60),
      ),
    ).toBe("嘗試次數過多，請於 1 分 0 秒後再試");
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
