/**
 * "This session was ended by a forced re-verification" marker (#266).
 *
 * When the silent recovery join (`acquireNewToken` in `pwa/src/App.tsx`) is
 * answered with a verification code, the PWA logs out and asks the user to sign
 * in again. If that happened because the user left the family on another
 * device, an ordinary landing-page join would re-add them as a new member. So:
 *
 *  - WRITE: `acquireNewToken`'s verification branch, and only there — a
 *    voluntary logout, `forceLogout` and the blocked-code branch never write it.
 *    Written right AFTER that branch's `logout()` (an await before it would
 *    reopen #258); `clearStorage` leaves this key alone, so it survives.
 *  - READ: `completeJoin` (`pwa/src/hooks/useLandingCompleteJoin.ts`). A join
 *    for the SAME family, server and user sends `recovery: 1`, so the server
 *    refuses it (409 RECOVERY_NOT_MEMBER) when the user is no longer listed.
 *  - CLEAR: a successful landing join that itself carried `recovery` (matched
 *    the marker), that 409 (the next submit is then the user's explicit
 *    re-join), and `forceClearStorage` in `useAuth.ts`. Another identity's
 *    successful login deliberately leaves it (shared device); a leftover marker
 *    is harmless — it only adds `recovery: 1` to a matching join. The key and
 *    `clearReauthPending` live in the import-free `reauthPendingKey.ts`
 *    (re-exported here) so `useAuth.ts` never pulls in `constants.ts`.
 *
 * Only the first 16 bits of a SHA-256 digest of the identity are stored, never
 * the raw familyId or server: the user may have turned "remember sync code" off.
 * The full digest would not hide it — familyId spans only ~2.8e12 values, the
 * default server is public and the userId sits in other key names, so it could
 * be brute-forced back offline. The price of truncating: an unrelated identity
 * matches 1 time in 65,536, and that join carries `recovery: 1` — a listed member
 * logs in normally; a new member gets one 409 RECOVERY_NOT_MEMBER, the marker is
 * cleared, and the next submit joins. The digest input goes through `sha256Hex`,
 * which lowercases it — harmless for an equality test.
 * The server is canonicalized exactly as `ApiClient` resolves it (absent →
 * `DEFAULT_API_ENDPOINT`), so a default-host or trailing-slash difference
 * between the stored session and a decoded sync code cannot make a match miss.
 *
 * Every access is wrapped like `recoveryCooldown.ts`: an unreadable store reads
 * as "no marker" (an ordinary join), and a refused write costs only the guard.
 */

import { classifySyncCodeApiHost } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { sha256Hex } from "moo-family-bookshelf-shared/crypto/hash";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { REAUTH_PENDING_KEY } from "./reauthPendingKey";

export { REAUTH_PENDING_KEY, clearReauthPending } from "./reauthPendingKey";

/** The triple a marker identifies; `apiHost` absent means the default server. */
export interface ReauthIdentity {
  familyId: string;
  userId: string;
  apiHost?: string;
}

/** The server `ApiClient` would call for `apiHost`, or `null` when refused. */
function canonicalEndpoint(apiHost: string | undefined): string | null {
  const verdict = classifySyncCodeApiHost(apiHost);
  if (verdict.kind === "valid") return verdict.endpoint;
  return verdict.kind === "none" ? DEFAULT_API_ENDPOINT : null;
}

/** Hex chars kept (16 bits): too few to invert to a familyId; a false match only adds one `recovery: 1`. */
export const MARKER_HEX_CHARS = 4;

async function digestIdentity(id: ReauthIdentity): Promise<string | null> {
  const endpoint = canonicalEndpoint(id.apiHost);
  if (endpoint === null) return null;
  try {
    const digest = await sha256Hex(
      JSON.stringify([id.familyId, endpoint, id.userId]),
    );
    return digest.slice(0, MARKER_HEX_CHARS);
  } catch {
    return null;
  }
}

/**
 * WRITES the marker for `id`. Never throws: a failed digest or a refused write
 * only costs the guard, so the caller's logout always proceeds.
 */
export async function markReauthPending(id: ReauthIdentity): Promise<void> {
  const digest = await digestIdentity(id);
  if (digest === null) return;
  try {
    localStorage.setItem(REAUTH_PENDING_KEY, digest);
  } catch {
    // Best-effort: a refused write costs the guard, never the logout.
  }
}

/** True when the stored marker names exactly `id`. Never throws. */
export async function isReauthPendingFor(id: ReauthIdentity): Promise<boolean> {
  let stored: string | null;
  try {
    stored = localStorage.getItem(REAUTH_PENDING_KEY);
  } catch {
    return false;
  }
  if (!stored) return false;
  return (await digestIdentity(id)) === stored;
}
