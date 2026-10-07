/** The re-verification marker's key and its CLEAR (#266). Keep this file import-free so `useAuth.ts`
 *  never reaches `constants.ts`: .claude/rules/frontend.md → PWA import chain. */

/** Truncated digests (`,`-joined) of the identities a forced re-verification signed out. */
export const REAUTH_PENDING_KEY = "moo:reauthPending";

/** REMOVES every marker, whoever they name. Never throws. */
export function clearReauthPending(): void {
  try {
    localStorage.removeItem(REAUTH_PENDING_KEY);
  } catch {
    // Best-effort; a leftover marker only adds `recovery: 1` to a matching join.
  }
}
