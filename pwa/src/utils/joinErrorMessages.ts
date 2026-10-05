/**
 * 繁體中文 copy for join failures that must be EXPLAINED to the user instead of
 * leaving them at a bare login form with no reason given.
 *
 * Shared by the two paths that can hit them so the wording cannot drift: the
 * token-recovery join in `pwa/src/App.tsx` (`acquireNewToken`) and the manual
 * join in `pwa/src/hooks/useLandingCompleteJoin.ts` (`completeJoin`).
 */

/**
 * No seat left in the family, so a rejoin cannot succeed. Used by BOTH join
 * paths — it is the entry `JOIN_BLOCKED_MESSAGES` carries for `FAMILY_FULL`,
 * named separately only so the manual-join branch gets a plain `string` instead
 * of a `string | undefined` it would have to unwrap.
 */
export const FAMILY_FULL_MESSAGE = "家庭成員已達上限（每個家庭最多 2 位成員）";

/**
 * Token-recovery join failures the landing page explains. Every one of them is
 * terminal — retrying the join cannot succeed.
 *
 *  - FAMILY_FULL       — no seat left to rejoin.
 *  - MEMBER_REMOVED    — the owner removed this member and the server's kicked
 *                        tombstone is refusing the rejoin.
 *  - FAMILY_NOT_FOUND  — the family was dissolved (or never existed), so there
 *                        is no record left for a rejoin to land in.
 *  - ALREADY_IN_FAMILY — the stored familyId no longer matches this account's
 *                        actual membership; only leaving the other family helps.
 *  - RECOVERY_NOT_MEMBER — this user is no longer listed in the family (left,
 *                        deleted the account, or was removed and the tombstone
 *                        expired); the server refuses a silent `recovery: 1`
 *                        join from a non-member so it cannot re-add them (#263).
 *
 * A `Map`, NOT an object literal, on purpose: the lookup key is `error.code`
 * straight off the wire, and a hostile or buggy self-hosted backend is an
 * explicit threat model in this project. An object literal answers keys off the
 * prototype chain — `__proto__` yields an object, `constructor` / `toString`
 * yield functions — so the lookup would return something other than
 * `string | undefined`: rendered as a React child that is a permanent white
 * screen (the PWA has no ErrorBoundary), or handed to a state setter where a
 * function is treated as an updater. A `Map` has no prototype chain to walk and
 * can only return a value that was put in. Mirrors the `Set` idiom in
 * `extension/src/api/auth-refresh.ts` (`FAMILY_GONE_ERROR_CODES`).
 *
 * Only the token-recovery path consults the whole table. The manual-join path
 * deliberately reuses `FAMILY_FULL_MESSAGE` alone and lets the others fall
 * through to its generic branch, which shows the server's own message — do not
 * reroute them here. (Its RECOVERY_NOT_MEMBER copy is the separate constant
 * `RECOVERY_NOT_MEMBER_LANDING_MESSAGE` below.)
 *
 * Test anchoring: `pwa/tests/component/App.test.tsx` renders every entry
 * through the landing page via THIS map (its key-set tripwire fails on a
 * removed or renamed code); the copy itself is pinned verbatim by
 * `pwa/tests/unit/joinErrorMessages.test.ts`, and `FAMILY_FULL` additionally by
 * `pwa/tests/component/LandingPage.test.tsx`.
 */
export const JOIN_BLOCKED_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["FAMILY_FULL", FAMILY_FULL_MESSAGE],
  ["MEMBER_REMOVED", "你已被家庭管理者移出，已為你登出"],
  ["FAMILY_NOT_FOUND", "找不到這個家庭，家庭可能已被解散"],
  ["ALREADY_IN_FAMILY", "此帳號已加入其他家庭，請先離開原本的家庭"],
  ["RECOVERY_NOT_MEMBER", "你已經不是這個家庭的成員，已為你登出"],
]);

/**
 * Landing-page form error when a re-login after a forced re-verification
 * (`pwa/src/utils/reauthPending.ts`, #266) meets 409 RECOVERY_NOT_MEMBER. Not the
 * `JOIN_BLOCKED_MESSAGES` entry: on the landing page nobody is being logged out.
 * The button it names is the form's submit label in `LandingForm.tsx`.
 */
export const RECOVERY_NOT_MEMBER_LANDING_MESSAGE =
  "你已經不是這個家庭的成員，可能已在其他裝置離開。如果要重新加入，請再按一次「開始使用」並完成驗證";

/**
 * Recovery-join failures that need the member's PWA-login secret. The recovery
 * join sends none, so REQUIRED is the realistic one; the other two are parity
 * with `VERIFICATION_ERROR_CODES` in `extension/src/api/auth-refresh.ts`.
 */
export const VERIFICATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "VERIFICATION_LOCKED",
]);

/**
 * Landing-page reason for a logout forced by `VERIFICATION_ERROR_CODES`. Not a
 * `JOIN_BLOCKED_MESSAGES` entry: re-verifying logs the user back in. The redo hint
 * is conditional: a leave (#263) triggers it, but so does a background-load 401.
 */
export const REVERIFY_LOGOUT_MESSAGE =
  "登入已失效，已為你登出。請重新登入並驗證身分，如果剛才有正在進行的操作，登入後請再做一次";
