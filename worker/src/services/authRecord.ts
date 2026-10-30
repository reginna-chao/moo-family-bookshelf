/** Read-only side of the auth-token lifecycle (#425): `auth:{userId}` normalization, bearer currency and the QR
 *  binding rule — never writes KV. See docs/architecture.md → PWA 登入驗證機制. */
import { type AuthRecord, type AuthTokenEntry } from "../kv/schema";
import { getRawAuthRecord, type RawAuthRecord } from "../kv/auth";
import { hashAuthToken, timingSafeEqual } from "../utils/crypto";

export const HEX_64 = /^[a-f0-9]{64}$/;

function isAuthTokenEntry(value: unknown): value is AuthTokenEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { hash?: unknown; createdAt?: unknown };
  return typeof entry.hash === "string" && typeof entry.createdAt === "string";
}

/**
 * Classify `auth:{userId}` as read (#425). Malformed list entries are dropped and a
 * non-array `tokens` reads as `[]`; `secretAt` is kept only when a number. `null` stays `null`.
 * An older `{ token, createdAt }` record reads as an empty list (#432).
 */
export function normalizeAuthRecord(
  raw: RawAuthRecord | null,
): AuthRecord | null {
  if (raw === null) return null;
  const tokens = Array.isArray(raw.tokens)
    ? raw.tokens
        .filter(isAuthTokenEntry)
        .map(({ hash, createdAt }) => ({ hash, createdAt }))
    : [];
  return {
    tokens,
    ...(typeof raw.secretAt === "number" && { secretAt: raw.secretAt }),
  };
}

/** Read `auth:{userId}` — the account's token list — normalized; `null` when there is none. */
export async function readAuthRecord(
  kv: KVNamespace,
  userId: string,
): Promise<AuthRecord | null> {
  return normalizeAuthRecord(await getRawAuthRecord(kv, userId));
}

/** `auth:{userId}` as read, whether the presented bearer is one of the account's current tokens, and its hash. */
export interface PresentedAuth {
  auth: AuthRecord | null;
  current: boolean;
  presentedHash: string | null;
}

function isCurrentBearer(
  auth: AuthRecord | null,
  presentedHash: string,
): boolean {
  if (auth === null) return true;
  return (
    auth.tokens.length === 0 ||
    auth.tokens.some((e) => timingSafeEqual(e.hash, presentedHash))
  );
}

/**
 * Bearer currency (#378, #425), the one rule shared by refresh (`renewPresentedAuthToken`),
 * `PUT /api/user/:id/verify`, `POST /api/user/:id/verify/prompted` and `DELETE /api/user/:id` (#396):
 * the presented token is current when its hash is in `auth:{userId}`'s list, or when
 * there is no record / an empty list (TTL gap). A
 * token that still has its `token:` key but is off the list (revoked on a lagging
 * colo, or orphaned by a concurrent mint) is NOT current. A missing bearer never is.
 * One KV read; the record and the bearer's hash are returned for reuse.
 */
export async function readPresentedAuth(
  kv: KVNamespace,
  userId: string,
  presentedToken: string | null,
): Promise<PresentedAuth> {
  const [auth, presentedHash] = await Promise.all([
    readAuthRecord(kv, userId),
    presentedToken === null ? null : hashAuthToken(presentedToken),
  ]);
  const current =
    presentedToken !== null &&
    presentedHash !== null &&
    isCurrentBearer(auth, presentedHash);
  return { auth, current, presentedHash };
}

/**
 * QR redeem rule (#378, #425): a QR token may skip verification only while the
 * just-read `auth` still lists the token that minted it. No KV op; the join then
 * checks that token's `token:` key before minting. A record without `tokenHash`
 * (older shape) never bypasses.
 */
export function isQrBoundToListedToken(
  tokenHash: string | undefined,
  auth: AuthRecord | null,
): boolean {
  return (
    typeof tokenHash === "string" &&
    auth !== null &&
    auth.tokens.some((e) => timingSafeEqual(e.hash, tokenHash))
  );
}
