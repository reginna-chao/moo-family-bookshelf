/** Forced re-verification markers (#266): a `,`-joined set of truncated identity digests.
 *  Rules: docs/architecture.md → 家庭解綁流程; implementation notes: → 背景自動復原的防護. */

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
