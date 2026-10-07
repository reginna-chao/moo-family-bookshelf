/** Copy for a FAILED `POST /api/family/:id/borrow`, shared so both apps read alike. SECURITY: code in,
 *  LOCAL string out — never server text. See docs/architecture.md → 借閱失敗文案只接受錯誤代碼. */

/** User-actionable failure codes plus the clients' `NETWORK_ERROR`; a `Map` so a backend `"__proto__"`
 *  misses. Omitted codes, no wait in RATE_LIMITED: docs/architecture.md → 借閱失敗文案只接受錯誤代碼. */
const BORROW_FAILURE_TEXTS: ReadonlyMap<string, string> = new Map([
  ["DUPLICATE_REQUEST", "這本書已有待處理的借閱申請，請到「借閱」查看"],
  [
    "TOO_MANY_PENDING_REQUESTS",
    "你的待處理借閱申請太多了，請先處理或取消部分申請",
  ],
  ["RATE_LIMITED", "申請借閱過於頻繁，請稍後再試"],
  ["LENDING_DISABLED", "借閱功能已關閉，請在家庭設定確認你與對方的借閱權限"],
  ["NOT_FAMILY_MEMBER", "你已不在這個家庭，無法申請借閱"],
  ["INVALID_OWNER", "無法申請借閱這本書，書籍擁有者已不在這個家庭"],
  ["INVALID_OWNER_SELF", "這是你自己的書，不需要申請借閱"],
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
