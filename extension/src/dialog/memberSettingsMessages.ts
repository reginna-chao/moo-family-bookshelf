/**
 * 繁體中文 copy for the member-settings write (PATCH
 * /api/family/:id/member/:uid), which is rate limited server-side.
 *
 * Extracted from `MemberList` because that endpoint has more than one caller:
 * `BorrowTab`'s readmoo member picker PATCHes `readmooName` too, and a 429 must
 * read the same in both places.
 */

import { ApiError, AUTH_REFRESH_RATE_LIMITED } from "../api/types";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";

/**
 * Failure copy for the member-settings writes, which throw instead of
 * returning an envelope. A 429 gets the localized back-off copy (with the wait
 * when the server sent one); everything else keeps the previous wording.
 *
 * The client-synthesized auth-recovery throttle passes through verbatim, the
 * same way `publicShareMessages.ts` handles it: its message is already
 * user-facing 繁體中文 naming an action the generic back-off sentence cannot
 * reconstruct. `synthesized` — not the code — is the authority for that
 * passthrough: only this client's own symbol marker sets it, so a
 * server-supplied envelope can never claim the code to paint arbitrary text.
 */
export function memberSettingsErrorMessage(
  err: unknown,
  fallback: string,
): string {
  if (err instanceof ApiError) {
    if (err.synthesized && err.code === AUTH_REFRESH_RATE_LIMITED) {
      return err.rawMessage || fallback;
    }
    const rateLimited = rateLimitedEnvelopeMessage(err);
    if (rateLimited !== null) return rateLimited;
  }
  return err instanceof Error ? err.message : fallback;
}
