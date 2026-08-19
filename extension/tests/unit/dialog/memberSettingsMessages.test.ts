import { describe, it, expect } from "vitest";
import { ApiError, AUTH_REFRESH_RATE_LIMITED } from "@/api/types";
import { memberSettingsErrorMessage } from "@/dialog/memberSettingsMessages";
import {
  rateLimitedEnvelopeMessage,
  rateLimitedMessage,
} from "@/dialog/verificationMessages";

/**
 * The member-settings write (PATCH /api/family/:id/member/:uid) THROWS an
 * `ApiError` instead of returning an envelope, and has more than one caller:
 * `MemberList`'s canLend toggle / readmooName delete and `BorrowTab`'s readmoo
 * member picker. This suite owns the mapping; the component tests assert
 * against the same production builders instead of restating copy.
 *
 * The literal wait strings are NOT restated here either — they belong to
 * `rateLimitedMessage`, pinned in tests/unit/dialog/verificationMessages.test.ts.
 */

/**
 * Stand-in for the client-synthesized auth-recovery throttle message. The real
 * one is produced by `buildRateLimitMessage` in `@/api/client` and asserted by
 * the "rate-limited recovery" suite in `tests/unit/client.test.ts` — this file
 * only pins that whatever that builder produced reaches the user untouched, so
 * the exact value below is illustrative, not the contract.
 */
const RECOVERY_COPY = "嘗試次數過多，請稍後再重新開啟書櫃（約 2 分鐘後）";

/**
 * The auth-recovery throttle exactly as `client.ts` raises it: `synthesized`
 * true, set there by an unforgeable module-private Symbol on the envelope.
 * Only this shape earns the verbatim passthrough — the code alone does not,
 * since any backend can put it in a response body.
 */
const synthesizedRecoveryError = (message: string, retryAfter?: number) =>
  new ApiError(AUTH_REFRESH_RATE_LIMITED, message, retryAfter, true);

/** The three fallbacks the production call sites pass in. */
const FALLBACKS = ["更新失敗", "刪除失敗", "儲存失敗"];

describe("memberSettingsErrorMessage", () => {
  describe("rate-limited (429 RATE_LIMITED)", () => {
    it.each([
      // [retryAfter] — the wait reaches the user instead of being dropped;
      // the wording itself belongs to rateLimitedMessage.
      [0],
      [45],
      [60],
      [90],
    ])("renders the back-off copy with the wait for retryAfter=%i", (wait) => {
      expect(
        memberSettingsErrorMessage(
          new ApiError("RATE_LIMITED", "Too many requests", wait),
          "更新失敗",
        ),
      ).toBe(rateLimitedMessage(wait));
    });

    it("falls back to the static back-off copy when the 429 carried no retryAfter", () => {
      expect(
        memberSettingsErrorMessage(
          new ApiError("RATE_LIMITED", "Too many requests"),
          "更新失敗",
        ),
      ).toBe(rateLimitedMessage(null));
    });

    it("emits exactly what rateLimitedEnvelopeMessage owns (no second copy)", () => {
      const err = new ApiError("RATE_LIMITED", "Too many requests", 45);

      expect(memberSettingsErrorMessage(err, "更新失敗")).toBe(
        rateLimitedEnvelopeMessage(err),
      );
    });

    it("never leaks the server's English text or the raw code", () => {
      const message = memberSettingsErrorMessage(
        new ApiError("RATE_LIMITED", "Too many requests", 45),
        "更新失敗",
      );

      expect(message).not.toContain("Too many requests");
      expect(message).not.toContain("RATE_LIMITED");
    });

    it("keeps the back-off copy for a synthesized RATE_LIMITED (marker alone is not the passthrough)", () => {
      // The passthrough needs BOTH the marker and the client-only code; a
      // client-built plain 429 stays on the shared back-off wording.
      expect(
        memberSettingsErrorMessage(
          new ApiError("RATE_LIMITED", "Too many requests", 60, true),
          "更新失敗",
        ),
      ).toBe(rateLimitedMessage(60));
    });
  });

  describe("client-synthesized auth-recovery throttle", () => {
    it("passes the synthesized AUTH_REFRESH_RATE_LIMITED message through verbatim", () => {
      expect(
        memberSettingsErrorMessage(
          synthesizedRecoveryError(RECOVERY_COPY),
          "儲存失敗",
        ),
      ).toBe(RECOVERY_COPY);
    });

    it("does not flatten AUTH_REFRESH_RATE_LIMITED into the generic 429 sentence", () => {
      // A retryAfter on this code must not divert it to the shared back-off
      // copy, which would drop the bespoke「重新開啟書櫃」guidance.
      const message = memberSettingsErrorMessage(
        synthesizedRecoveryError(RECOVERY_COPY, 120),
        "儲存失敗",
      );

      expect(message).toBe(RECOVERY_COPY);
      expect(message).not.toBe(rateLimitedMessage(120));
    });

    it("falls back to the caller's wording when the synthesized error carried no message", () => {
      // Marked as client-built, so the passthrough branch IS taken — an empty
      // rawMessage must still not render as a blank error line.
      expect(
        memberSettingsErrorMessage(synthesizedRecoveryError(""), "儲存失敗"),
      ).toBe("儲存失敗");
    });

    /**
     * The security half of the passthrough rule: `userId`-addressed endpoints
     * can be answered by any backend the user (or an invite's `@host` segment)
     * points the client at, so a code alone is never authority to paint
     * attacker-chosen text into the dialog as if it were this app's own copy.
     * Only the client's own unforgeable marker is.
     */
    it("refuses the verbatim passthrough for an unmarked AUTH_REFRESH_RATE_LIMITED error", () => {
      const hostile = new ApiError(AUTH_REFRESH_RATE_LIMITED, "任意惡意文案");

      const message = memberSettingsErrorMessage(hostile, "更新失敗");

      // Only the unchanged "CODE: message" shape an unmapped code has always
      // rendered — never the bare bespoke sentence the marker would earn.
      expect(message).toBe(hostile.message);
      expect(message).not.toBe(hostile.rawMessage);
      expect(message).toContain(AUTH_REFRESH_RATE_LIMITED);
    });
  });

  describe("everything else keeps the previous wording", () => {
    // Real codes from PATCH /api/family/:id/member/:uid (worker/src/routes/family.ts).
    it.each([
      ["FORBIDDEN", "Only the family owner can change canLend"],
      ["MEMBER_NOT_FOUND", "Target user is not a family member"],
      ["NOT_FAMILY_MEMBER", "You are not a member of this family"],
      ["INVALID_FIELDS", "canLend must be 0 or 1"],
    ])("renders the thrown message for a non-429 %s", (code, serverText) => {
      const err = new ApiError(code, serverText);

      expect(memberSettingsErrorMessage(err, "更新失敗")).toBe(err.message);
    });

    it("renders a plain Error's message", () => {
      expect(memberSettingsErrorMessage(new Error("boom"), "更新失敗")).toBe(
        "boom",
      );
    });

    it.each([
      ["a thrown string", "boom"],
      ["undefined", undefined],
      ["null", null],
      ["a number", 429],
      ["a plain object", { code: "RATE_LIMITED", retryAfter: 60 }],
    ])("falls back for %s (non-Error rejections)", (_label, thrown) => {
      expect(memberSettingsErrorMessage(thrown, "更新失敗")).toBe("更新失敗");
    });

    it.each(FALLBACKS)(
      "returns the caller's own %s wording (each call site keeps its verb)",
      (fallback) => {
        expect(memberSettingsErrorMessage("boom", fallback)).toBe(fallback);
      },
    );
  });
});
