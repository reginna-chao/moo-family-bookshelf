/** Thin data access (#425) for `auth:{userId}` and `token:{hash}` — one KV op each, no validation. Old-shape
 *  normalization and multi-key fan-out live in middleware/auth.ts. See docs/architecture.md → PWA 登入驗證機制. */
import { kvKeys, type AuthTokenRecord, type StoredAuthRecord } from "./schema";

/** `auth:{userId}` exactly as read: the #425 shape (`tokens`, `secretAt`) or the older one (`token`, `createdAt`). */
export interface RawAuthRecord {
  tokens?: unknown;
  secretAt?: unknown;
  token?: unknown;
  createdAt?: unknown;
}

/** Read `auth:{userId}` as JSON, unvalidated (`normalizeAuthRecord` classifies it). `null` when absent. */
export async function getRawAuthRecord(
  kv: KVNamespace,
  userId: string,
): Promise<RawAuthRecord | null> {
  return kv.get<RawAuthRecord>(kvKeys.auth(userId), "json");
}

/**
 * Write `auth:{userId}`. No TTL (#425): a code account's tokens slide past any fixed TTL,
 * and a lapsed list would turn revoke-all into a no-op. Dead entries are evicted by the
 * next mint; leave / kick / delete remove the key. The value is rebuilt as a literal
 * `{ tokens, secretAt? }`, so passing an `AuthRecord` can never write its in-memory
 * `legacyToken` back to KV.
 */
export async function putAuthRecord(
  kv: KVNamespace,
  userId: string,
  record: StoredAuthRecord,
): Promise<void> {
  const { tokens, secretAt } = record;
  const stored: StoredAuthRecord = {
    tokens,
    ...(typeof secretAt === "number" && { secretAt }),
  };
  await kv.put(kvKeys.auth(userId), JSON.stringify(stored));
}

/** Delete `auth:{userId}` — the revoke-all half that drops the token list. */
export async function deleteAuthRecord(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.auth(userId));
}

/** Read `token:{tokenHash}` as JSON, unvalidated. `null` covers expired, revoked and never-existed. */
export async function getAuthTokenRecord(
  kv: KVNamespace,
  tokenHash: string,
): Promise<AuthTokenRecord | null> {
  return kv.get<AuthTokenRecord>(kvKeys.authToken(tokenHash), "json");
}

/**
 * Read a pre-#425 `token:{plaintext}` key as text — its value is the bare userId.
 * Transition fallback only; removed once every such key has expired (90 days
 * after release, see docs/secret-token-storage-plan.md 第 4 節).
 */
export async function getLegacyAuthTokenUserId(
  kv: KVNamespace,
  plaintextToken: string,
): Promise<string | null> {
  return kv.get(kvKeys.authToken(plaintextToken));
}

/** Write `token:{tokenHash}` as JSON with the caller's TTL (90 days at mint, up to the absolute cap on refresh). */
export async function putAuthTokenRecord(
  kv: KVNamespace,
  tokenHash: string,
  record: AuthTokenRecord,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(kvKeys.authToken(tokenHash), JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });
}

/** Delete one `token:{keyTail}` key — a token hash, or a pre-#425 plaintext token. */
export async function deleteAuthTokenKey(
  kv: KVNamespace,
  keyTail: string,
): Promise<void> {
  await kv.delete(kvKeys.authToken(keyTail));
}
