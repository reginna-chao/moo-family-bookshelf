import { describe, it, expect } from "vitest";
import { ApiError } from "@/api/client";
import {
  publicShelfErrorMessage,
  publicShelfSaveErrorMessage,
  UNSAVED_NOTICE,
  BLANK_TITLE_MESSAGE,
} from "@/utils/publicShareMessages";

/**
 * COPY PIN (anti-drift). This file is the single place where the literal
 * user-facing public-shelf failure strings are asserted. The component test
 * asserts against the imported builders instead of restating the copy, so a
 * wording change fails HERE — loudly and in exactly one place.
 *
 * The wording mirrors `extension/src/dialog/publicShareMessages.ts` except
 * where the two apps genuinely differ: UNAUTHORIZED tells a PWA user to log in
 * again (the Extension tells them to reopen the shelf), and the 429 copy comes
 * from the PWA's own `buildRetryMessage`, which ends in a full stop.
 */

describe("publicShelfErrorMessage", () => {
  it.each([
    ["INVALID_TITLE", "標題需為 1 至 60 個字"],
    ["INVALID_EXPIRES_DAYS", "過期時間選項無效，請重新選擇"],
    ["MAX_SHELVES_REACHED", "已達公開書櫃數量上限"],
    ["SHELF_NOT_FOUND", "找不到這個公開書櫃，請重新開啟視窗"],
    ["USER_NOT_FOUND", "請先同步個人書櫃，再啟用公開分享"],
    ["UNAUTHORIZED", "登入狀態已失效，請重新登入"],
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
    [45, "嘗試次數過多，請於 45 秒後再試。"],
    [90, "嘗試次數過多，請於 1 分 30 秒後再試。"],
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

  it.each([
    ["the backend sent no retryAfter", undefined],
    ["the backend sent a zero retryAfter", 0],
  ])(
    "falls back to the static RATE_LIMITED wording when %s",
    (_label, retryAfter) => {
      expect(
        publicShelfErrorMessage(
          new ApiError("RATE_LIMITED", "too many requests", retryAfter),
          "關閉失敗",
        ),
      ).toBe("嘗試次數過多，請稍後再試。");
    },
  );

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
    ).toBe("嘗試次數過多，請於 1 分 30 秒後再試。（變更尚未儲存）");
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
});

describe("standalone notices", () => {
  it("pins the unsaved-notice wording", () => {
    expect(UNSAVED_NOTICE).toBe("變更尚未儲存");
  });

  it("pins the client-side blank-title rejection wording", () => {
    expect(BLANK_TITLE_MESSAGE).toBe("標題不可留白（變更尚未儲存）");
  });
});
