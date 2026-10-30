/** Auth-token writes (#425): minting a new token (with cap eviction and legacy migration) and revoking an
 *  account's `token:` keys (revoke-all drops `auth:` too). See docs/architecture.md → PWA 登入驗證機制. */
import {
  MAX_AUTH_TOKENS_PER_USER,
  TOKEN_TTL_SECONDS,
  type AuthRecord,
  type AuthTokenEntry,
} from "../kv/schema";
import {
  deleteAuthRecord,
  deleteAuthTokenKey,
  getAuthTokenRecord,
  putAuthRecord,
  putAuthTokenRecord,
} from "../kv/auth";
import { hashAuthToken } from "../utils/crypto";
import { buildLiveLegacyMigration, readAuthRecord } from "./authRecord";

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
 * (revoked, `auth:` read stale) is dropped, never revived. Evicted keys are deleted
 * FIRST — a throw fails the mint. A migration then puts its `token:{hash}` BEFORE
 * `auth:`, so a list never names a hash with no record behind it; `auth:` is put
 * exactly once with the new token appended (alongside the new `token:{hash}`), and
 * only then is `token:{plaintext}` deleted. Once `auth:` no longer names it, a
 * plaintext key is INERT — the middleware refuses it — so a failed delete is
 * logged and ignored (the mint still returns the token) and the key merely
 * occupies its TTL. `secretAt` replaces the carried-forward
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

  if (migration) {
    await putAuthTokenRecord(
      kv,
      migration.entry.hash,
      migration.record,
      TOKEN_TTL_SECONDS,
    );
  }
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

/**
 * Delete every `token:` key `auth` names — each listed hash, a legacy plaintext
 * token AND its hash (covering a migration whose `auth:` put never landed), and
 * `alsoKeys` — the presented bearer's hash AND its plaintext (a pre-#425 key, for
 * an `auth:` gap) — deduplicated; deleting an absent key is a no-op. Never
 * touches `auth:{userId}`, so a following mint is that key's only write.
 */
export async function revokeAuthTokenKeys(
  kv: KVNamespace,
  auth: AuthRecord | null,
  alsoKeys: readonly (string | null | undefined)[] = [],
): Promise<void> {
  const keys = new Set<string>((auth?.tokens ?? []).map((e) => e.hash));
  if (typeof auth?.legacyToken === "string") {
    keys.add(auth.legacyToken);
    keys.add(await hashAuthToken(auth.legacyToken));
  }
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
