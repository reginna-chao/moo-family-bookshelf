/** Auth-token renewal for `POST /api/auth/refresh` (#425): slide the presented token's TTL, migrate a
 *  pre-#425 one in place, or mint anew in a TTL gap. See docs/architecture.md → PWA 登入驗證機制. */
import {
  KV_MIN_TTL_SECONDS,
  TOKEN_MAX_AGE_SECONDS,
  TOKEN_RENEW_SKIP_WINDOW_MS,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type AuthTokenEntry,
} from "../kv/schema";
import {
  getAuthTokenRecord,
  putAuthRecord,
  putAuthTokenIndex,
  putAuthTokenRecord,
} from "../kv/auth";
import { getVerifyRecord } from "../kv/verify";
import { timingSafeEqual } from "../utils/crypto";
import { buildLiveLegacyMigration, readPresentedAuth } from "./authRecord";
import {
  deleteMigratedPlaintextKey,
  mintAuthToken,
  type IssuedToken,
} from "./authTokens";

/** Refresh's one-time move of a live pre-#425 token into the list (`null` when dead): `tokenidx:`, `token:{hash}`, then
 *  `auth:` (a throw stops the rest), then a fail-open delete of the inert `token:{plaintext}` — docs/architecture.md → PWA 登入驗證機制. */
async function migratePresentedLegacyToken(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord,
  legacyToken: string,
): Promise<IssuedToken | null> {
  const migration = await buildLiveLegacyMigration(
    kv,
    userId,
    legacyToken,
    Date.now(),
  );
  if (migration === null) return null;
  await putAuthTokenIndex(kv, userId, migration.entry.hash, TOKEN_TTL_SECONDS);
  await putAuthTokenRecord(
    kv,
    migration.entry.hash,
    migration.record,
    TOKEN_TTL_SECONDS,
  );
  await putAuthRecord(kv, userId, {
    tokens: [migration.entry],
    secretAt: auth.secretAt,
  });
  await deleteMigratedPlaintextKey(kv, migration.plaintext);
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

/** Slide one listed token's `token:{hash}` TTL, re-putting its `tokenidx:` key first with the same TTL (a throw writes
 *  nothing more); never writes `auth:`, and skips both puts when nothing would change. */
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
  await putAuthTokenIndex(kv, userId, entry.hash, ttlSeconds);
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
 * in place (same string back) while its plaintext key is live, else `null`; a TTL gap
 * (no record, empty list) mints a new token. Every path that writes `token:{hash}`
 * puts that token's `tokenidx:` key first, with the same TTL (#431).
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
