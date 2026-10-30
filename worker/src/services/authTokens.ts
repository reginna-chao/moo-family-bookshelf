/** Auth-token writes (#425, #431): minting a new token (cap eviction, legacy migration, `tokenidx:` index) and revoking
 *  an account's `token:` keys via its list AND index (revoke-all drops `auth:` too). See docs/architecture.md → PWA 登入驗證機制. */
import {
  kvKeys,
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type AuthTokenEntry,
} from "../kv/schema";
import {
  deleteAuthRecord,
  deleteAuthTokenIndex,
  deleteAuthTokenKey,
  getAuthTokenRecord,
  listAuthTokenIndexPage,
  putAuthRecord,
  putAuthTokenIndex,
  putAuthTokenRecord,
} from "../kv/auth";
import { hashAuthToken } from "../utils/crypto";
import { buildLiveLegacyMigration, HEX_64, readAuthRecord } from "./authRecord";

/** Upper bound on `tokenidx:` list pages per listing; a page holds up to 1000 keys, an account normally a handful. */
const MAX_INDEX_PAGES = 10;

/** Indexes one revoke processes: 400 `token:` + 400 index deletes plus the caller's own ops (PIN save ~830, kick ~900)
 *  stay under KV's 1,000 operations per Worker invocation; docs/architecture.md → 撤銷全部也刪得到不在清單上的 token. */
export const MAX_REVOKE_INDEX_HASHES = 400;

/** Listed index hashes; `capped` = the listing stopped at its maximum and more indexes may remain unlisted. */
export interface IndexHashListing {
  hashes: string[];
  capped: boolean;
}

/** A list page as received, every field unknown until the guards in `listIndexHashesUpTo` pass. */
interface IndexListPage {
  keys: unknown;
  list_complete: unknown;
  cursor?: unknown;
}

function indexKeyName(key: unknown): string | null {
  if (typeof key !== "object" || key === null) return null;
  const { name } = key as { name?: unknown };
  return typeof name === "string" ? name : null;
}

/**
 * The token hashes the account's `tokenidx:{userId}:` keys name (#431), page by page
 * in KV's lexicographic order, stopping at `max`: the first `max` are kept, `capped`
 * is set, and no further page is fetched. Throws on a malformed page (`keys` not an
 * array, `list_complete` not a boolean), an incomplete page without a string cursor,
 * a repeated cursor, or more than `MAX_INDEX_PAGES` pages. Only tails matching
 * `HEX_64` are returned — anything else is skipped, so a stray key can never steer a
 * `token:` delete.
 */
async function listIndexHashesUpTo(
  kv: KVNamespace,
  userId: string,
  max: number,
): Promise<IndexHashListing> {
  const prefix = kvKeys.authTokenIndex(userId, "");
  const hashes: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 1; ; pages += 1) {
    if (pages > MAX_INDEX_PAGES) throw new Error("token index: too many pages");
    const page: IndexListPage = await listAuthTokenIndexPage(
      kv,
      userId,
      cursor,
    );
    if (!Array.isArray(page.keys) || typeof page.list_complete !== "boolean")
      throw new Error("token index: malformed list page");
    for (const key of page.keys as unknown[]) {
      const name = indexKeyName(key);
      if (name === null || !name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length);
      if (!HEX_64.test(tail)) continue;
      if (hashes.length >= max) return { hashes, capped: true };
      hashes.push(tail);
    }
    if (page.list_complete) return { hashes, capped: false };
    if (hashes.length >= max) return { hashes, capped: true };
    const next = page.cursor;
    if (typeof next !== "string" || !next || cursors.has(next))
      throw new Error("token index: bad list cursor");
    cursors.add(next);
    cursor = next;
  }
}

/** Every indexed token hash, uncapped — the guards of `listIndexHashesUpTo` apply. */
export async function listAuthTokenIndexHashes(
  kv: KVNamespace,
  userId: string,
): Promise<string[]> {
  return (await listIndexHashesUpTo(kv, userId, Number.POSITIVE_INFINITY))
    .hashes;
}

/** The indexed hashes one revoke processes: at most `MAX_REVOKE_INDEX_HASHES`, the rest left for the next revoke. */
export async function listRevocableIndexHashes(
  kv: KVNamespace,
  userId: string,
): Promise<IndexHashListing> {
  return listIndexHashesUpTo(kv, userId, MAX_REVOKE_INDEX_HASHES);
}

/** Fail-open: a leftover index names a `token:` key that is already gone — harmless. No ids logged. */
async function deleteIndexKeys(
  kv: KVNamespace,
  userId: string,
  hashes: readonly string[],
): Promise<void> {
  await Promise.all(
    hashes.map((h) => deleteAuthTokenIndex(kv, userId, h)),
  ).catch((err: unknown) => {
    console.error("AUTH_TOKEN_INDEX_DELETE_FAILED", { err });
  });
}

/** A token handed to the client, with the epoch-ms expiry it was stored for. */
export interface IssuedToken {
  token: string;
  expiresAt: number;
}

/** Fail-open: after the hashed writes a leftover `token:{plaintext}` is inert (`resolveTokenUserId`). No ids logged. */
export async function deleteMigratedPlaintextKey(
  kv: KVNamespace,
  plaintext: string,
): Promise<void> {
  await deleteAuthTokenKey(kv, plaintext).catch((err: unknown) => {
    console.error("LEGACY_TOKEN_DELETE_FAILED", { err });
  });
}

function compareIso(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Make room for one new token at the cap: dead entries first, then oldest `createdAt`; `alive` is never read.
 *  See docs/architecture.md → PWA 登入驗證機制. */
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
 * out — but only while its `token:{plaintext}` key still names `userId`: a dead one
 * (revoked, `auth:` read stale) is dropped, never revived. Write order (#431):
 * evicted `token:` keys are deleted FIRST — a throw fails the mint — then their
 * `tokenidx:` keys, fail-open (`AUTH_TOKEN_INDEX_DELETE_FAILED`; a leftover index
 * names a deleted key). Every `token:{hash}` put is preceded by its
 * `tokenidx:{userId}:{hash}` put with the same TTL, and an index failure throws
 * before that token exists, so revoke-all can list every token this mint writes.
 * A migration puts its index, then its `token:{hash}`, BEFORE `auth:`, so a list
 * never names a hash with no record behind it; then the new token's index, then
 * `auth:` (put exactly once, new token appended) together with the new
 * `token:{hash}`; only then is `token:{plaintext}` deleted. Once `auth:` no longer
 * names it, a plaintext key is INERT — the middleware refuses it — so a failed
 * delete is logged and ignored (the mint still returns the token) and the key
 * merely occupies its TTL. `secretAt` replaces the carried-forward
 * `knownAuth.secretAt` (PIN/pattern only).
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
  const [hash, migration] = await Promise.all([
    hashAuthToken(token),
    buildLiveLegacyMigration(kv, userId, knownAuth?.legacyToken, now),
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

  await Promise.all(evicted.map((key) => deleteAuthTokenKey(kv, key)));
  await deleteIndexKeys(kv, userId, evicted);

  if (migration) {
    await putAuthTokenIndex(
      kv,
      userId,
      migration.entry.hash,
      TOKEN_TTL_SECONDS,
    );
    await putAuthTokenRecord(
      kv,
      migration.entry.hash,
      migration.record,
      TOKEN_TTL_SECONDS,
    );
  }
  await putAuthTokenIndex(kv, userId, hash, TOKEN_TTL_SECONDS);
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
  ]);
  if (migration) await deleteMigratedPlaintextKey(kv, migration.plaintext);

  return { token, expiresAt };
}

/** The revocable hashes, fail-open: a list failure (KV refusal, quota, shape guard) reads as none. No ids logged. */
async function listIndexHashesOrNone(
  kv: KVNamespace,
  userId: string,
): Promise<IndexHashListing> {
  try {
    return await listRevocableIndexHashes(kv, userId);
  } catch (err: unknown) {
    console.error("AUTH_TOKEN_INDEX_LIST_FAILED", { err });
    return { hashes: [], capped: false };
  }
}

/**
 * Delete every `token:` key of the account — each hash `auth` lists, a legacy
 * plaintext token AND its hash (covering a migration whose `auth:` put never
 * landed), `alsoKeys` — the presented bearer's hash AND its plaintext (a pre-#425
 * key, for an `auth:` gap) — and every hash its `tokenidx:{userId}:` keys name,
 * which reaches a token a racing mint left off the list (#431); deduplicated,
 * deleting an absent key is a no-op. The index is listed FIRST (so a following
 * mint's new index is never in it); a list failure is logged
 * (`AUTH_TOKEN_INDEX_LIST_FAILED`) and the known set is still deleted — revoke-all
 * runs this beside `deleteAuthRecord`, so throwing would leave every token alive
 * with `auth:` gone. A `token:` delete failure throws with every index kept, so a
 * retry finds them; only after all succeed are the LISTED index keys deleted,
 * fail-open. At most `MAX_REVOKE_INDEX_HASHES` indexes are processed per call (the
 * per-invocation op budget); past that `AUTH_TOKEN_INDEX_CAPPED` logs the count only,
 * and because the processed indexes are deleted, repeated revokes converge on the
 * rest. Never touches `auth:{userId}`, so a following mint is its only write.
 */
export async function revokeAuthTokenKeys(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord | null,
  alsoKeys: readonly (string | null | undefined)[] = [],
): Promise<void> {
  const { hashes: indexed, capped } = await listIndexHashesOrNone(kv, userId);
  if (capped)
    console.error("AUTH_TOKEN_INDEX_CAPPED", { listed: indexed.length });
  const keys = new Set<string>((auth?.tokens ?? []).map((e) => e.hash));
  if (typeof auth?.legacyToken === "string") {
    keys.add(auth.legacyToken);
    keys.add(await hashAuthToken(auth.legacyToken));
  }
  for (const key of alsoKeys) if (typeof key === "string") keys.add(key);
  for (const hash of indexed) keys.add(hash);
  await Promise.all([...keys].map((key) => deleteAuthTokenKey(kv, key)));
  await deleteIndexKeys(kv, userId, indexed);
}

/** Revoke all of the account's tokens — listed and indexed, plus `alsoKeys` — and drop `auth:{userId}`, reusing the
 *  caller's read of it. */
export async function revokeAllAuthTokens(
  kv: KVNamespace,
  userId: string,
  knownAuth: AuthRecord | null,
  alsoKeys: readonly (string | null | undefined)[] = [],
): Promise<void> {
  await Promise.all([
    revokeAuthTokenKeys(kv, userId, knownAuth, alsoKeys),
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
