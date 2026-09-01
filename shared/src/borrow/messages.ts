/**
 * Copy for a FAILED borrow request created from the family shelf
 * (`POST /api/family/:id/borrow`).
 *
 * The Extension dialog and the PWA page fire the same endpoint from the same
 * 「申請借閱」 button, so a failure must read identically on both sides; the
 * table lives here rather than once per app, where the two copies would drift.
 *
 * SECURITY — code in, LOCAL string out. This module accepts ONLY the
 * machine-readable `code` and returns a fixed 繁體中文 sentence. It must never
 * accept, interpolate, or return server-supplied message text. The API
 * endpoint is user-configurable (BYO backend, and a sync code's `@host` lets
 * whoever wrote the invite pick it), so an envelope's `message` is
 * attacker-controlled text: rendering it verbatim would let a hostile backend
 * paint arbitrary content into the dialog. Only an `ApiError` the client
 * SYNTHESIZED itself is allowed that passthrough — see the
 * `ApiError.synthesized` JSDoc in `extension/src/api/types.ts`. Do not
 * "improve" this by adding a `message` / `rawMessage` parameter and falling
 * back to it.
 *
 * Pure and runtime-agnostic: no globals, no side effects.
 */

/**
 * Every failure code `POST /api/family/:id/borrow` can answer with that a user
 * can act on, plus the API clients' own `NETWORK_ERROR` (fetch rejected, no
 * envelope). Codes that only a malformed client request can trigger
 * (`INVALID_FAMILY_ID` / `INVALID_JSON` / `MISSING_FIELDS` / `INVALID_FIELDS` /
 * `INVALID_USER_ID`) and `INTERNAL_ERROR` are deliberately absent — they carry
 * no user-actionable advice and fall back to the generic sentence.
 *
 * A `Map`, not an object literal: `code` is backend-controlled, and an object
 * lookup would resolve `"__proto__"` / `"toString"` through the prototype
 * chain.
 *
 * `RATE_LIMITED` states no wait in seconds on purpose. The envelope's
 * `retryAfter` is formatted by helpers the two apps deliberately keep separate
 * (they disagree on `retryAfter === 0` — see the `rateLimitedEnvelopeMessage`
 * JSDoc in `extension/src/dialog/verificationMessages.ts`), so interpolating it
 * here would reintroduce exactly the drift this module exists to prevent.
 */
const BORROW_FAILURE_TEXTS: ReadonlyMap<string, string> = new Map([
  ["DUPLICATE_REQUEST", "這本書已有待處理的借閱申請，請到「借閱」查看"],
  ["RATE_LIMITED", "申請借閱過於頻繁，請稍後再試"],
  ["LENDING_DISABLED", "借閱功能已關閉，請在家庭設定確認你與對方的借閱權限"],
  ["NOT_FAMILY_MEMBER", "你已不在這個家庭，無法申請借閱"],
  ["INVALID_OWNER", "無法申請借閱這本書，書籍擁有者已不在這個家庭"],
  ["FAMILY_NOT_FOUND", "找不到這個家庭，請重新開啟書櫃後再試"],
  ["UNAUTHORIZED", "登入狀態已失效，請重新開啟書櫃後再試"],
  ["INVALID_COVER_URL", "書籍封面網址無效，無法建立借閱申請"],
  ["NETWORK_ERROR", "連線失敗，請檢查網路後再試"],
]);

/**
 * Shown for an unrecognized code and for a rejection that carried none — a
 * thrown value with no envelope at all still owes the user a report, which is
 * the whole point of surfacing this banner.
 */
export const BORROW_FAILURE_FALLBACK_TEXT = "申請借閱失敗，請稍後再試";

/** User-facing 繁體中文 for a borrow-create failure, keyed by error `code`. */
export function buildBorrowFailureText(code: string | undefined): string {
  if (code === undefined) return BORROW_FAILURE_FALLBACK_TEXT;
  return BORROW_FAILURE_TEXTS.get(code) ?? BORROW_FAILURE_FALLBACK_TEXT;
}
