/**
 * The re-verification marker's storage key and its CLEAR, with NO imports (#266).
 *
 * Split out of `reauthPending.ts` because `useAuth.ts` needs `clearReauthPending`
 * and the Node-side Playwright helpers import `useAuth`: reaching `constants.ts`
 * would evaluate `import.meta.env`, which is undefined under plain Node (see the
 * trailing comment in `constants.ts`). Keep this file dependency-free.
 */

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
