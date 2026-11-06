// The codes the verification prompt reacts to; split out of useVerificationPrompt.ts.

const VERIFICATION_CODES = new Set([
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "VERIFICATION_LOCKED",
]);

/** True when a join errorCode is one the verification prompt should handle. */
export function isVerificationError(code: string | undefined): boolean {
  return code !== undefined && VERIFICATION_CODES.has(code);
}

/** Client-side refusal from `runReauthJoin`: the client left the server the prompt opened on, or
 *  storage no longer pairs that server and family with the stored token. See docs/architecture.md → 重新驗證視窗. */
export const STALE_SESSION_CODE = "STALE_SESSION";
export const STALE_SESSION_MESSAGE = "家庭資料已變更，請重新整理頁面。";

/** Prompt copy for a failed attempt with no branch of its own. It takes the code only, so a
 *  self-hosted server's own text never reaches the prompt. */
export function attemptFailureText(code: string | undefined): string {
  return code === STALE_SESSION_CODE
    ? STALE_SESSION_MESSAGE
    : "發生錯誤，請稍後再試";
}
