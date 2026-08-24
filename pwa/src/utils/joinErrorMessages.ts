/**
 * 繁體中文 copy for join failures that must be EXPLAINED to the user instead of
 * leaving them at a bare login form with no reason given.
 *
 * Shared by the two paths that can hit them so the wording cannot drift: the
 * token-recovery join in `pwa/src/App.tsx` (`acquireNewToken`) and the manual
 * join in `pwa/src/pages/LandingPage.tsx` (`completeJoin`).
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
 * deliberately reuses `FAMILY_FULL_MESSAGE` alone and lets the other three fall
 * through to its generic branch, which shows the server's own message — do not
 * reroute them here.
 *
 * Test anchoring: `pwa/tests/component/App.test.tsx` renders every entry
 * through the landing page via THIS map (its key-set tripwire fails on a
 * removed or renamed code); `FAMILY_FULL` is additionally pinned verbatim by
 * `pwa/tests/component/LandingPage.test.tsx`.
 */
export const JOIN_BLOCKED_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["FAMILY_FULL", FAMILY_FULL_MESSAGE],
  ["MEMBER_REMOVED", "你已被家庭管理者移出，已為你登出"],
  ["FAMILY_NOT_FOUND", "找不到這個家庭，家庭可能已被解散"],
  ["ALREADY_IN_FAMILY", "此帳號已加入其他家庭，請先離開原本的家庭"],
]);
