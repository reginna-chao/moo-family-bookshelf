/** Read-only side of the auth-token lifecycle (#425): `auth:{userId}` normalization, legacy-token liveness, bearer
 *  currency and the QR binding rule — never writes KV. See docs/architecture.md → PWA 登入驗證機制. */
import {
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type AuthTokenEntry,
  type AuthTokenRecord,
} from "../kv/schema";
import {
  getLegacyAuthTokenUserId,
  getRawAuthRecord,
  type RawAuthRecord,
} from "../kv/auth";
import { hashAuthToken, timingSafeEqual } from "../utils/crypto";

export const HEX_64 = /^[a-f0-9]{64}$/;

function isAuthTokenEntry(value: unknown): value is AuthTokenEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { hash?: unknown; createdAt?: unknown };
  return typeof entry.hash === "string" && typeof entry.createdAt === "string";
}

/**
 * Classify `auth:{userId}` as read (#425). Malformed list entries are dropped and a
 * non-array `tokens` reads as `[]`; `secretAt` is kept only when a number; a pre-#425
 * record's string `token` surfaces as `legacyToken` (in memory only). `null` stays `null`.
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
    ...(typeof raw.token === "string" && { legacyToken: raw.token }),
  };
}

/** Read `auth:{userId}` — the account's token list — normalized; `null` when there is none. */
export async function readAuthRecord(
  kv: KVNamespace,
  userId: string,
): Promise<AuthRecord | null> {
  return normalizeAuthRecord(await getRawAuthRecord(kv, userId));
}

/** A pre-#425 plaintext token moved into the hashed model: its list entry, its `token:{hash}` value, its old key tail. */
interface LegacyMigration {
  entry: AuthTokenEntry;
  record: AuthTokenRecord;
  plaintext: string;
}

/** `legacyToken` while its `token:{plaintext}` key still names `userId`, else `null` (never revive a revoked one).
 *  One KV read; see docs/architecture.md → PWA 登入驗證機制. */
async function readLiveLegacyToken(
  kv: KVNamespace,
  userId: string,
  legacyToken: string,
): Promise<string | null> {
  const owner = await getLegacyAuthTokenUserId(kv, legacyToken);
  const alive = typeof owner === "string" && HEX_64.test(owner);
  return alive && owner === userId ? legacyToken : null;
}

/** Called only with a live token; the caller puts `record`, then lists `entry`, then deletes `token:{plaintext}`. */
async function buildLegacyMigration(
  legacyToken: string,
  userId: string,
  now: number,
): Promise<LegacyMigration> {
  const createdAt = new Date(now).toISOString();
  const hash = await hashAuthToken(legacyToken);
  return {
    entry: { hash, createdAt },
    record: { userId, createdAt, expiresAt: now + TOKEN_TTL_SECONDS * 1000 },
    plaintext: legacyToken,
  };
}

/** The migration of `legacyToken` when it is still live (`readLiveLegacyToken`); `null` when absent or dead. */
export async function buildLiveLegacyMigration(
  kv: KVNamespace,
  userId: string,
  legacyToken: string | undefined,
  now: number,
): Promise<LegacyMigration | null> {
  if (legacyToken === undefined) return null;
  const live = await readLiveLegacyToken(kv, userId, legacyToken);
  return live === null ? null : buildLegacyMigration(live, userId, now);
}

/** `auth:{userId}` as read, whether the presented bearer is one of the account's current tokens, and its hash. */
export interface PresentedAuth {
  auth: AuthRecord | null;
  current: boolean;
  presentedHash: string | null;
}

function isCurrentBearer(
  auth: AuthRecord | null,
  presentedToken: string,
  presentedHash: string,
): boolean {
  if (auth === null) return true;
  if (auth.legacyToken !== undefined) {
    return timingSafeEqual(auth.legacyToken, presentedToken);
  }
  return (
    auth.tokens.length === 0 ||
    auth.tokens.some((e) => timingSafeEqual(e.hash, presentedHash))
  );
}

/**
 * Bearer currency (#378, #425), the one rule shared by refresh (`renewPresentedAuthToken`),
 * `PUT /api/user/:id/verify`, `POST /api/user/:id/verify/prompted` and `DELETE /api/user/:id` (#396):
 * the presented token is current when its hash is in `auth:{userId}`'s list, when a
 * pre-#425 record names it, or when there is no record / an empty list (TTL gap). A
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
    isCurrentBearer(auth, presentedToken, presentedHash);
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
