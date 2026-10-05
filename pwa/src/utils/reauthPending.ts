/**
 * "This session was ended by a forced re-verification" markers (#266).
 *
 * When the silent recovery join (`acquireNewToken` in `pwa/src/App.tsx`) is
 * answered with a verification code, the PWA logs out and asks the user to sign
 * in again. If that happened because the user left the family on another
 * device, an ordinary landing-page join would re-add them as a new member. So:
 *
 *  - WRITE: `acquireNewToken`'s verification branch, and only there — a
 *    voluntary logout, `forceLogout` and the blocked-code branch never write it.
 *    Written right AFTER that branch's `logout()` (an await before it would
 *    reopen #258); `clearStorage` leaves this key alone, so it survives. The key
 *    holds a SET — one marker per identity still awaiting re-verification — so
 *    another account's forced logout on a shared device ADDS its own marker
 *    instead of overwriting this one.
 *  - READ: `completeJoin` (`pwa/src/hooks/useLandingCompleteJoin.ts`). A join
 *    for the SAME family, server and user sends `recovery: 1`, so the server
 *    refuses it (409 RECOVERY_NOT_MEMBER) when the user is no longer listed.
 *  - CLEAR: `clearReauthPendingFor` removes ONLY one identity's marker, on a
 *    successful landing join that itself carried `recovery` (matched it) or on
 *    that 409 (the next submit is then the user's explicit re-join). Another
 *    identity's login leaves every other marker alone (shared device); a
 *    leftover marker is harmless — it only adds `recovery: 1` to a matching
 *    join. `forceClearStorage` in `useAuth.ts` removes the whole key through
 *    `clearReauthPending`, which lives with the key in the import-free
 *    `reauthPendingKey.ts` (re-exported here) so `useAuth.ts` never pulls in
 *    `constants.ts`.
 *
 * Stored value: the markers joined by `,`, oldest first, capped at
 * `MAX_PENDING_MARKERS` (the oldest are dropped beyond it; an evicted identity
 * falls back to an ordinary join — residual). An empty set removes the key.
 * Entries that are not exactly `MARKER_HEX_CHARS` lowercase hex chars (legacy
 * or garbage values) are ignored, so they read as "no marker".
 *
 * Only the first 16 bits of a SHA-256 digest of the identity are stored, never
 * the raw familyId or server: the user may have turned "remember sync code" off.
 * The full digest would not hide it — familyId spans only ~2.8e12 values, the
 * default server is public and the userId sits in other key names, so it could
 * be brute-forced back offline. The price of truncating: an unrelated identity
 * matches one marker 1 time in 65,536 (at most 16 in 65,536 with a full set),
 * and that join carries `recovery: 1` — a listed member logs in normally; a new
 * member gets one 409 RECOVERY_NOT_MEMBER, the matched marker is cleared, and
 * the next submit joins. The digest input goes through `sha256Hex`, which
 * lowercases it — harmless for an equality test.
 * The server is canonicalized exactly as `ApiClient` resolves it (absent →
 * `DEFAULT_API_ENDPOINT`), so a default-host or trailing-slash difference
 * between the stored session and a decoded sync code cannot make a match miss.
 *
 * Every access is wrapped like `recoveryCooldown.ts`: an unreadable store reads
 * as "no marker" (an ordinary join), and a refused write costs only the guard.
 * Read-modify-write is not atomic across tabs and is deliberately unlocked: a
 * lost update costs at most one marker (an ordinary join), never a lock-out.
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

/** Hex chars kept (16 bits): too few to invert to a familyId; a false match only adds one `recovery: 1`. */
export const MARKER_HEX_CHARS = 4;

/** Most identities kept at once; beyond it the oldest marker is dropped (that identity joins ordinarily). */
export const MAX_PENDING_MARKERS = 16;

const MARKER_SEPARATOR = ",";
const MARKER_PATTERN = new RegExp(`^[0-9a-f]{${MARKER_HEX_CHARS}}$`);

/** The server `ApiClient` would call for `apiHost`, or `null` when refused. */
function canonicalEndpoint(apiHost: string | undefined): string | null {
  const verdict = classifySyncCodeApiHost(apiHost);
  if (verdict.kind === "valid") return verdict.endpoint;
  return verdict.kind === "none" ? DEFAULT_API_ENDPOINT : null;
}

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

/** Valid, de-duplicated markers in stored order (oldest first); anything else is dropped. */
function parseMarkers(raw: string | null): string[] {
  if (!raw) return [];
  const valid = raw
    .split(MARKER_SEPARATOR)
    .filter((entry) => MARKER_PATTERN.test(entry));
  return [...new Set(valid)];
}

/** `markers` plus `digest` as the newest entry, trimmed to the cap from the oldest end. */
function withMarker(markers: string[], digest: string): string[] {
  if (markers.includes(digest)) return markers;
  return [...markers, digest].slice(-MAX_PENDING_MARKERS);
}

function withoutMarker(markers: string[], digest: string): string[] {
  return markers.filter((marker) => marker !== digest);
}

/** The value to store, or `null` when the set is empty (the key is removed). */
function serializeMarkers(markers: string[]): string | null {
  return markers.length > 0 ? markers.join(MARKER_SEPARATOR) : null;
}

/** The stored markers, or `null` when the store cannot be read. */
function readMarkers(): string[] | null {
  try {
    return parseMarkers(localStorage.getItem(REAUTH_PENDING_KEY));
  } catch {
    return null;
  }
}

function writeMarkers(markers: string[]): void {
  const value = serializeMarkers(markers);
  try {
    if (value === null) localStorage.removeItem(REAUTH_PENDING_KEY);
    else localStorage.setItem(REAUTH_PENDING_KEY, value);
  } catch {
    // Best-effort: a refused write costs the guard, never the caller's flow.
  }
}

/**
 * ADDS `id`'s marker to the set (no-op when already present). Never throws: a
 * failed digest, an unreadable store or a refused write only costs the guard,
 * so the caller's logout always proceeds. An unreadable store skips the write
 * rather than replace markers it could not read.
 */
export async function markReauthPending(id: ReauthIdentity): Promise<void> {
  const digest = await digestIdentity(id);
  if (digest === null) return;
  const markers = readMarkers();
  if (markers === null || markers.includes(digest)) return;
  writeMarkers(withMarker(markers, digest));
}

/** True when the set holds `id`'s marker. Never throws. */
export async function isReauthPendingFor(id: ReauthIdentity): Promise<boolean> {
  const markers = readMarkers();
  if (markers === null || markers.length === 0) return false;
  const digest = await digestIdentity(id);
  return digest !== null && markers.includes(digest);
}

/**
 * REMOVES only `id`'s marker, leaving every other identity's. Never throws; the
 * key is removed once the set is empty. A failed removal leaves a harmless
 * marker that only adds `recovery: 1` to a matching join.
 */
export async function clearReauthPendingFor(id: ReauthIdentity): Promise<void> {
  const digest = await digestIdentity(id);
  if (digest === null) return;
  const markers = readMarkers();
  if (markers === null || !markers.includes(digest)) return;
  writeMarkers(withoutMarker(markers, digest));
}
