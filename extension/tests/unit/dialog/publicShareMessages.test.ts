import { describe, it, expect } from "vitest";
import { ApiError, AUTH_REFRESH_RATE_LIMITED } from "@/api/types";
import {
  publicShelfErrorMessage,
  publicShelfSaveErrorMessage,
  UNSAVED_NOTICE,
  BLANK_TITLE_MESSAGE,
} from "@/dialog/publicShareMessages";

/**
 * COPY PIN (anti-drift). This file is the single place where the literal
 * user-facing public-shelf failure strings are asserted. The component test
 * asserts against the imported builders instead of restating the copy, so a
 * wording change fails HERE — loudly and in exactly one place.
 */

/**
 * Stand-in for the client-synthesized auth-recovery throttle message. Its real
 * literal is produced by `buildRateLimitMessage` in `@/api/client` and pinned by
 * the "rate-limited recovery" suite in `tests/unit/client.test.ts` — this file
 * only pins that whatever that builder produced reaches the user untouched.
 */
const RECOVERY_COPY = "登入狀態已失效，請約 2 分鐘後重新開啟書櫃";

/**
 * The auth-recovery throttle exactly as `client.ts` raises it: `synthesized`
 * true, set there by an unforgeable module-private Symbol on the envelope.
 * Only this shape earns the verbatim passthrough — the code alone does not,
 * since any backend can put it in a response body.
 */
const synthesizedRecoveryError = (message: string, retryAfter?: number) =>
  new ApiError(AUTH_REFRESH_RATE_LIMITED, message, retryAfter, true);

describe("publicShelfErrorMessage", () => {
  it.each([
    ["INVALID_TITLE", "標題需為 1 至 60 個字"],
    ["INVALID_EXPIRES_DAYS", "過期時間選項無效，請重新選擇"],
    ["MAX_SHELVES_REACHED", "已達公開書櫃數量上限"],
    ["SHELF_NOT_FOUND", "找不到這個公開書櫃，請重新開啟視窗"],
    ["USER_NOT_FOUND", "請先同步個人書櫃，再啟用公開分享"],
    ["UNAUTHORIZED", "登入狀態已失效，請重新開啟書櫃"],
    ["FORBIDDEN", "沒有權限操作這個公開書櫃"],
    ["NETWORK_ERROR", "連線失敗，請檢查網路後再試"],
  ])("maps %s to its 繁體中文 wording", (code, expected) => {
    expect(
      publicShelfErrorMessage(
        new ApiError(code, "english server text"),
        "關閉失敗",
      ),
    ).toBe(expected);
  });

  it.each([
    // [retryAfter, expected] — the wait reaches the user instead of being
    // dropped, and 60s+ flips to the 分/秒 form.
    [0, "嘗試次數過多，請於 0 秒後再試"],
    [45, "嘗試次數過多，請於 45 秒後再試"],
    [90, "嘗試次數過多，請於 1 分 30 秒後再試"],
  ])(
    "renders the RATE_LIMITED countdown for retryAfter=%i",
    (retryAfter, expected) => {
      expect(
        publicShelfErrorMessage(
          new ApiError("RATE_LIMITED", "too many requests", retryAfter),
          "關閉失敗",
        ),
      ).toBe(expected);
    },
  );

  it("falls back to the static RATE_LIMITED wording when the backend sent no retryAfter", () => {
    expect(
      publicShelfErrorMessage(
        new ApiError("RATE_LIMITED", "too many requests"),
        "關閉失敗",
      ),
    ).toBe("嘗試次數過多，請稍後再試");
  });

  it.each([
    ["載入失敗"],
    ["建立失敗"],
    ["儲存失敗"],
    ["重設失敗"],
    ["關閉失敗"],
  ])(
    "falls back to the caller's %s wording for an unmapped code",
    (fallback) => {
      expect(
        publicShelfErrorMessage(
          new ApiError("KV_WRITE_FAILED", "internal server error"),
          fallback,
        ),
      ).toBe(fallback);
    },
  );

  it("passes a synthesized AUTH_REFRESH_RATE_LIMITED message through verbatim", () => {
    expect(
      publicShelfErrorMessage(
        synthesizedRecoveryError(RECOVERY_COPY),
        "關閉失敗",
      ),
    ).toBe(RECOVERY_COPY);
  });

  it("does not flatten AUTH_REFRESH_RATE_LIMITED into the generic 429 sentence", () => {
    // A retryAfter on this code must not divert it to the shared back-off copy,
    // which would drop the bespoke「請重新開啟書櫃」guidance.
    const message = publicShelfErrorMessage(
      synthesizedRecoveryError(RECOVERY_COPY, 120),
      "關閉失敗",
    );

    expect(message).toBe(RECOVERY_COPY);
    expect(message).not.toContain("嘗試次數過多");
  });

  it("falls back to the caller's wording when AUTH_REFRESH_RATE_LIMITED carried no message", () => {
    // Marked as client-built, so the passthrough branch IS taken — an empty
    // rawMessage must still not render as a blank error line.
    expect(
      publicShelfErrorMessage(synthesizedRecoveryError(""), "關閉失敗"),
    ).toBe("關閉失敗");
  });

  /**
   * The security half of the passthrough rule: `userId`-addressed endpoints can
   * be answered by any backend the user (or an invite's `@host` segment) points
   * the client at, so a code alone is never authority to paint attacker-chosen
   * text into the dialog. Only the client's own unforgeable marker is — see the
   * wire-side pin in `tests/unit/api/publicShelfClient.test.ts`.
   */
  it("refuses the verbatim passthrough for an unmarked AUTH_REFRESH_RATE_LIMITED error", () => {
    const message = publicShelfErrorMessage(
      new ApiError(AUTH_REFRESH_RATE_LIMITED, "任意惡意文案"),
      "關閉失敗",
    );

    expect(message).toBe("關閉失敗");
    expect(message).not.toContain("任意惡意文案");
  });

  it("never leaks the raw server English into the returned copy", () => {
    const message = publicShelfErrorMessage(
      new ApiError("KV_WRITE_FAILED", "internal server error"),
      "關閉失敗",
    );

    expect(message).not.toContain("internal server error");
    expect(message).not.toContain("KV_WRITE_FAILED");
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["a thrown string", "boom"],
    ["undefined", undefined],
    ["null", null],
  ])("falls back for %s (non-ApiError rejections)", (_label, thrown) => {
    expect(publicShelfErrorMessage(thrown, "關閉失敗")).toBe("關閉失敗");
  });
});

describe("publicShelfSaveErrorMessage", () => {
  it("states the divergence alongside the mapped reason", () => {
    expect(
      publicShelfSaveErrorMessage(new ApiError("INVALID_TITLE", "bad title")),
    ).toBe("標題需為 1 至 60 個字（變更尚未儲存）");
  });

  it("states the divergence alongside the rate-limit countdown", () => {
    expect(
      publicShelfSaveErrorMessage(
        new ApiError("RATE_LIMITED", "too many requests", 90),
      ),
    ).toBe("嘗試次數過多，請於 1 分 30 秒後再試（變更尚未儲存）");
  });

  it("uses the 儲存失敗 fallback for an unmapped code", () => {
    expect(
      publicShelfSaveErrorMessage(new ApiError("KV_WRITE_FAILED", "boom")),
    ).toBe("儲存失敗（變更尚未儲存）");
  });

  it("always ends with the unsaved notice so the user knows the value is local-only", () => {
    expect(publicShelfSaveErrorMessage(new Error("boom"))).toContain(
      UNSAVED_NOTICE,
    );
  });

  it("keeps the verbatim auth-recovery copy and still states the divergence", () => {
    expect(
      publicShelfSaveErrorMessage(synthesizedRecoveryError(RECOVERY_COPY)),
    ).toBe(`${RECOVERY_COPY}（${UNSAVED_NOTICE}）`);
  });

  // The save path is where this error is most often rendered, so the marker
  // requirement has to hold here too — not just in the bare message mapper.
  it("does not render an unmarked AUTH_REFRESH_RATE_LIMITED message on the save path", () => {
    const message = publicShelfSaveErrorMessage(
      new ApiError(AUTH_REFRESH_RATE_LIMITED, "任意惡意文案"),
    );

    expect(message).toBe(`儲存失敗（${UNSAVED_NOTICE}）`);
    expect(message).not.toContain("任意惡意文案");
  });
});

describe("standalone notices", () => {
  it("pins the unsaved-notice wording", () => {
    expect(UNSAVED_NOTICE).toBe("變更尚未儲存");
  });

  it("pins the client-side blank-title rejection wording", () => {
    expect(BLANK_TITLE_MESSAGE).toBe("標題不可留白（變更尚未儲存）");
  });
});
