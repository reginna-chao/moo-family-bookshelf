import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { Env } from "../utils/env";
import {
  KV_MIN_TTL_SECONDS,
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_MAX_AGE_SECONDS,
  TOKEN_RENEW_SKIP_WINDOW_MS,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type AuthTokenEntry,
  type AuthTokenRecord,
} from "../kv/schema";
import {
  deleteAuthRecord,
  deleteAuthTokenKey,
  getAuthTokenRecord,
  getLegacyAuthTokenUserId,
  getRawAuthRecord,
  putAuthRecord,
  putAuthTokenRecord,
  type RawAuthRecord,
} from "../kv/auth";
import { getVerifyRecord } from "../kv/verify";
import { isPublicRoute } from "../utils/routes";
import { jsonError } from "../utils/errors";
import { hashAuthToken, timingSafeEqual } from "../utils/crypto";

// Extend Hono Variables to carry authenticated userId
declare module "hono" {
  interface ContextVariableMap {
    authUserId: string | null; // null = no auth header (fallback mode)
  }
}

const HEX_64 = /^[a-f0-9]{64}$/;

/** The 64-char hex token of a `Bearer <token>` header, or `null` when the header is absent or malformed. */
function parseBearerToken(authHeader: string | undefined): string | null {
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  if (!match || !HEX_64.test(match[1])) return null;
  return match[1];
}

/** userId of a bearer: `token:{hash}` first; only on a miss the pre-#425 `token:{plaintext}` (#425 transition). */
async function resolveTokenUserId(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  const record = await getAuthTokenRecord(kv, await hashAuthToken(token));
  if (record !== null) {
    const userId: unknown = record.userId;
    return typeof userId === "string" && userId !== "" ? userId : null;
  }
  // A 64-hex value only: a #425 record read at a plaintext-shaped key (its hash as bearer) is refused.
  const legacy = await getLegacyAuthTokenUserId(kv, token);
  return typeof legacy === "string" && HEX_64.test(legacy) ? legacy : null;
}

/**
 * Auth middleware: checks Authorization header.
 * Requires valid Bearer token for all protected routes.
 * Public routes (create/join family) are skipped.
 */
export const authMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    if (isPublicRoute(c.req.method, c.req.path)) {
      c.set("authUserId", null);
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");

    if (!authHeader) {
      return jsonError(c, 401, "UNAUTHORIZED", "Authorization header required");
    }

    const token = parseBearerToken(authHeader);
    if (!token) {
      return jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    const userId = await resolveTokenUserId(c.env.KV, token);
    if (!userId) {
      return jsonError(c, 401, "UNAUTHORIZED", "Invalid or expired token");
    }

    c.set("authUserId", userId);
    await next();
  },
);

/**
 * Returns the authenticated userId from context.
 * Returns null if not authenticated (should not happen on protected routes).
 */
export function getAuthenticatedUserId(c: Context): string | null {
  return c.get("authUserId") as string | null;
}

/** The bearer token the request presented (already validated by `authMiddleware` on protected routes). */
export function getPresentedAuthToken(c: Context): string | null {
  return parseBearerToken(c.req.header("Authorization"));
}

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

/** A token handed to the client, with the epoch-ms expiry it was stored for. */
export interface IssuedToken {
  token: string;
  expiresAt: number;
}

/** A pre-#425 plaintext token moved into the hashed model: its list entry, its `token:{hash}` value, its old key tail. */
interface LegacyMigration {
  entry: AuthTokenEntry;
  record: AuthTokenRecord;
  plaintext: string;
}

/** Shared by mint and refresh; the caller lists `entry`, puts `record` and deletes `token:{plaintext}`. */
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

function compareIso(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Make room for one new token: when `previous` holds `MAX_AUTH_TOKENS_PER_USER` or
 * more, evict entries whose `token:{hash}` is gone (or names another user) first,
 * then the oldest `createdAt` (earlier list position on a tie). Reads `token:` only
 * then; `alive` (a just-migrated entry, not written yet) is never read.
 */
async function evictForNewToken(
  kv: KVNamespace,
  userId: string,
  previous: AuthTokenEntry[],
  alive: AuthTokenEntry | null,
): Promise<{ kept: AuthTokenEntry[]; evicted: string[] }> {
  const excess = previous.length - (MAX_AUTH_TOKENS_PER_USER - 1);
  if (excess <= 0) return { kept: previous, evicted: [] };
  const records = await Promise.all(
    previous.map((e) => (e === alive ? null : getAuthTokenRecord(kv, e.hash))),
  );
  const ranked = previous
    .map((entry, index) => {
      const dead = entry !== alive && records[index]?.userId !== userId;
      return { entry, index, dead };
    })
    .sort(
      (a, b) =>
        Number(b.dead) - Number(a.dead) ||
        compareIso(a.entry.createdAt, b.entry.createdAt) ||
        a.index - b.index,
    );
  const out = new Set(ranked.slice(0, excess).map((r) => r.index));
  return {
    kept: previous.filter((_, i) => !out.has(i)),
    evicted: previous.filter((_, i) => out.has(i)).map((e) => e.hash),
  };
}

function generateTokenString(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mint a NEW token for `userId` (#425; create, join, QR redeem, PIN/pattern save).
 * `knownAuth` is the caller's `auth:{userId}` read (`null` = none, or a full revoke
 * just ran); a legacy plaintext token in it is migrated into the list, never logged
 * out. Evicted keys (and the migrated plaintext key) are deleted FIRST — a throw
 * fails the mint — then `auth:` is put exactly once with the new token appended.
 * `secretAt` replaces the carried-forward `knownAuth.secretAt` (PIN/pattern only).
 */
export async function mintAuthToken(
  kv: KVNamespace,
  userId: string,
  knownAuth: AuthRecord | null,
  secretAt?: number,
): Promise<IssuedToken> {
  const token = generateTokenString();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = now + TOKEN_TTL_SECONDS * 1000;
  const legacyToken = knownAuth?.legacyToken;
  const [hash, migration] = await Promise.all([
    hashAuthToken(token),
    legacyToken === undefined
      ? null
      : buildLegacyMigration(legacyToken, userId, now),
  ]);

  const previous = [
    ...(knownAuth?.tokens ?? []),
    ...(migration ? [migration.entry] : []),
  ];
  const { kept, evicted } = await evictForNewToken(
    kv,
    userId,
    previous,
    migration?.entry ?? null,
  );

  const staleKeys = [...evicted, ...(migration ? [migration.plaintext] : [])];
  await Promise.all(staleKeys.map((key) => deleteAuthTokenKey(kv, key)));

  await Promise.all([
    putAuthRecord(kv, userId, {
      tokens: [...kept, { hash, createdAt }],
      secretAt: secretAt ?? knownAuth?.secretAt,
    }),
    putAuthTokenRecord(
      kv,
      hash,
      { userId, createdAt, expiresAt },
      TOKEN_TTL_SECONDS,
    ),
    ...(migration
      ? [
          putAuthTokenRecord(
            kv,
            migration.entry.hash,
            migration.record,
            TOKEN_TTL_SECONDS,
          ),
        ]
      : []),
  ]);

  return { token, expiresAt };
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

/** Refresh's one-time move of a current pre-#425 token into the list; the only renewal that writes `auth:`. */
async function migratePresentedLegacyToken(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord,
  legacyToken: string,
): Promise<IssuedToken> {
  const migration = await buildLegacyMigration(legacyToken, userId, Date.now());
  await Promise.all([
    putAuthRecord(kv, userId, {
      tokens: [migration.entry],
      secretAt: auth.secretAt,
    }),
    putAuthTokenRecord(
      kv,
      migration.entry.hash,
      migration.record,
      TOKEN_TTL_SECONDS,
    ),
    deleteAuthTokenKey(kv, migration.plaintext),
  ]);
  return { token: legacyToken, expiresAt: migration.record.expiresAt };
}

/** Sliding 90 days, capped 180 days after `createdAt` — except on a `code` account (one extra read, cap only). */
async function renewalTarget(
  kv: KVNamespace,
  userId: string,
  createdAt: string,
  now: number,
): Promise<number | null> {
  const slidingMs = now + TOKEN_TTL_SECONDS * 1000;
  const capMs = Date.parse(createdAt) + TOKEN_MAX_AGE_SECONDS * 1000;
  if (Number.isNaN(capMs)) return null;
  if (capMs >= slidingMs) return slidingMs;
  const verify = await getVerifyRecord(kv, userId);
  return verify?.method === "code" ? slidingMs : capMs;
}

/** Slide one listed token's `token:{hash}` TTL; never writes `auth:`, and skips the put when nothing would change. */
async function slideListedToken(
  kv: KVNamespace,
  userId: string,
  entry: AuthTokenEntry,
  presentedToken: string,
): Promise<IssuedToken | null> {
  const stored = await getAuthTokenRecord(kv, entry.hash);
  if (stored === null || stored.userId !== userId) return null;
  const now = Date.now();
  const target = await renewalTarget(kv, userId, entry.createdAt, now);
  if (target === null) return null;
  const ttlSeconds = Math.floor((target - now) / 1000);
  if (ttlSeconds < KV_MIN_TTL_SECONDS) return null;
  if (
    typeof stored.expiresAt === "number" &&
    target - stored.expiresAt < TOKEN_RENEW_SKIP_WINDOW_MS
  ) {
    return { token: presentedToken, expiresAt: stored.expiresAt };
  }
  await putAuthTokenRecord(
    kv,
    entry.hash,
    { userId, createdAt: entry.createdAt, expiresAt: target },
    ttlSeconds,
  );
  return { token: presentedToken, expiresAt: target };
}

/**
 * Refresh (#425): renews only the PRESENTED token. `null` (→ 401 REFRESH_FAILED)
 * when it is not current (`readPresentedAuth`), its `token:` key is gone, or it is
 * past the 180-day cap (PIN / pattern / none accounts). A pre-#425 token is migrated
 * in place (same string back); a TTL gap (no record, empty list) mints a new token.
 */
export async function renewPresentedAuthToken(
  kv: KVNamespace,
  userId: string,
  presentedToken: string,
): Promise<IssuedToken | null> {
  const { auth, current, presentedHash } = await readPresentedAuth(
    kv,
    userId,
    presentedToken,
  );
  if (!current || presentedHash === null) return null;
  if (auth?.legacyToken !== undefined) {
    return migratePresentedLegacyToken(kv, userId, auth, auth.legacyToken);
  }
  if (auth === null || auth.tokens.length === 0) {
    return mintAuthToken(kv, userId, auth);
  }
  const entry = auth.tokens.find((e) => timingSafeEqual(e.hash, presentedHash));
  if (!entry) return null;
  return slideListedToken(kv, userId, entry, presentedToken);
}

/**
 * Delete every `token:` key `auth` names — each listed hash, a legacy plaintext
 * token, and `alsoKeys` — the presented bearer's hash AND its plaintext (a
 * pre-#425 key, for an `auth:` gap) — deduplicated; deleting an absent key is a
 * no-op. Never touches `auth:{userId}`, so a following mint is that key's only write.
 */
export async function revokeAuthTokenKeys(
  kv: KVNamespace,
  auth: AuthRecord | null,
  alsoKeys: readonly (string | null | undefined)[] = [],
): Promise<void> {
  const keys = new Set<string>((auth?.tokens ?? []).map((e) => e.hash));
  if (typeof auth?.legacyToken === "string") keys.add(auth.legacyToken);
  for (const key of alsoKeys) if (typeof key === "string") keys.add(key);
  await Promise.all([...keys].map((key) => deleteAuthTokenKey(kv, key)));
}

/** Revoke all of the account's tokens (plus `alsoKeys`) and drop `auth:{userId}`, reusing the caller's read of it. */
export async function revokeAllAuthTokens(
  kv: KVNamespace,
  userId: string,
  knownAuth: AuthRecord | null,
  alsoKeys: readonly (string | null | undefined)[] = [],
): Promise<void> {
  await Promise.all([
    revokeAuthTokenKeys(kv, knownAuth, alsoKeys),
    deleteAuthRecord(kv, userId),
  ]);
}

/** `revokeAllAuthTokens` for a caller that has not read `auth:{userId}` (leave / kick / dissolve). */
export async function readAndRevokeAllAuthTokens(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await revokeAllAuthTokens(kv, userId, await readAuthRecord(kv, userId));
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
