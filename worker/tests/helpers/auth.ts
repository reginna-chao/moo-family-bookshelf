/** Shared auth-token seeding for tests — the rationale (hashed `token:` key, token list,
 *  `kvKeys`, no TTL, one-half seeds, legacy shape) is in `seedAuthToken`'s JSDoc. */

import { expect } from "vitest";
import {
  kvKeys,
  TOKEN_TTL_SECONDS,
  type AuthTokenEntry,
  type AuthTokenRecord,
  type StoredAuthRecord,
} from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";
import { mintAuthToken } from "../../src/services/authTokens";

/**
 * Deterministic 64-char auth token derived from a 64-hex userId.
 *
 * Test convention only — production tokens are 32 random bytes hex-encoded
 * (`crypto.getRandomValues` in `services/authTokens.ts`). Deriving keeps a suite's
 * token readable next to its userId. Distinctness holds only while the FIRST
 * 32 chars of two userIds differ — true for the fixed-nibble ids in
 * `helpers/ids.ts`, but NOT for `makeUserId()` ids (they share an all-`0`
 * prefix, so every derived token collides); pass an explicit `opts.token`
 * when seeding several `makeUserId()` users.
 */
export function tokenFor(userId: string): string {
  return userId.slice(0, 32).repeat(2);
}

/** Overrides for callers that need a specific token, a fixed issue time, or several devices. */
export interface SeedAuthTokenOptions {
  /** Use this exact token instead of `tokenFor(userId)`. */
  token?: string;
  /** ISO `createdAt` of the token (both halves), default now; pass a fixed past value when the
   *  token's age is under test (e.g. `/api/auth/refresh` near the 180-day cap). */
  createdAt?: string;
  /** Append to the existing `auth:{userId}` list instead of replacing it (a second device). */
  appendTo?: boolean;
  /** `auth:{userId}.secretAt` to write (#378) — the PIN/pattern rotation stamp a stale-record check compares. */
  secretAt?: number;
}

/**
 * Seed KV with a complete, valid #425 auth token for `userId` and return the
 * token, ready to send as `Authorization: Bearer <token>`.
 *
 * An auth token has TWO KV halves with different consumers:
 * - `token:{hashAuthToken(token)}` → `{ userId, createdAt, expiresAt }` — the
 *   ONLY key `middleware/auth.ts` reads to authenticate a request. The token
 *   itself is never stored; `expiresAt` is `createdAt` + 90 days.
 * - `auth:{userId}` → `{ tokens: [{ hash, createdAt }] }` — the account's
 *   token list (one entry per device); read by the mint / refresh / revoke
 *   paths (`mintAuthToken`, `renewPresentedAuthToken`, `revokeAllAuthTokens`)
 *   and by `readPresentedAuth`'s "is this bearer current" rule.
 *
 * A token-only seed therefore still authenticates; what it breaks is refresh
 * and cleanup (e.g. `/api/auth/refresh` refusing an unlisted token, account
 * deletion not finding the key). Seeding both halves matches the state a
 * really-minted token is in. By default the list is REPLACED with this one
 * token; `opts.appendTo` reads the existing list and appends, for multi-device
 * cases.
 *
 * Keys are built through the production `kvKeys` helpers and `hashAuthToken` on
 * purpose: if the `token:` / `auth:` prefixes or the hash ever change, these
 * seeds follow and keep pointing at the keys production actually reads,
 * instead of seeding dead keys and silently asserting 401s. Never inline the
 * raw key strings here.
 *
 * Unlike production writes, these seeds carry no `expirationTtl`. A test that
 * asserts auth-key TTLs must go through the production `mintAuthToken()`.
 *
 * Nor do they write the `tokenidx:{userId}:{hash}` key production puts before
 * every `token:{hash}` (#431): a seeded token is in the state of one minted
 * before the index existed — revoke-all reaches it through the `auth:` list
 * only. A test about the index mints through `mintAuthToken()`.
 *
 * Tests that deliberately seed only ONE half (only `token:{hash}`, or an
 * `auth:` record with no matching token key) must keep doing that inline —
 * that asymmetry is the thing under test, not a case for this helper. The
 * pre-#425 plaintext shape is `seedLegacyAuthToken`.
 */
export async function seedAuthToken(
  kv: KVNamespace,
  userId: string,
  opts?: SeedAuthTokenOptions,
): Promise<string> {
  const token = opts?.token ?? tokenFor(userId);
  const hash = await hashAuthToken(token);
  const createdAt = opts?.createdAt ?? new Date().toISOString();
  const tokenRecord: AuthTokenRecord = {
    userId,
    createdAt,
    expiresAt: Date.parse(createdAt) + TOKEN_TTL_SECONDS * 1000,
  };
  const existing = opts?.appendTo
    ? await kv.get<StoredAuthRecord>(kvKeys.auth(userId), "json")
    : null;
  const entry: AuthTokenEntry = { hash, createdAt };
  const record: StoredAuthRecord = {
    ...existing,
    tokens: [...(existing?.tokens ?? []), entry],
    ...(opts?.secretAt !== undefined && { secretAt: opts.secretAt }),
  };
  await kv.put(kvKeys.authToken(hash), JSON.stringify(tokenRecord));
  await kv.put(kvKeys.auth(userId), JSON.stringify(record));
  return token;
}

/** The `token:{hash}` key production reads for `token` (#425) — never `token:{token}`. */
export async function authTokenKey(token: string): Promise<string> {
  return kvKeys.authToken(await hashAuthToken(token));
}

/** The `tokenidx:{userId}:{hash}` key production puts before `token`'s `token:{hash}` key (#431). */
export async function authTokenIndexKey(
  userId: string,
  token: string,
): Promise<string> {
  return kvKeys.authTokenIndex(userId, await hashAuthToken(token));
}

/**
 * The `writeTrail()` entries of a revoke-all of `userId` (#431), pointer
 * excluded: the `list` of its index prefix, the `auth:` delete, a `token:`
 * delete per `revoked` token and a `tokenidx:` delete per `indexed` token (the
 * tokens whose index the list returned — a seeded token has none). Unordered:
 * compare as a set and pin the order with {@link expectRevokeIndexOrder}.
 */
export async function revokeAllTrailEntries(
  userId: string,
  revoked: readonly string[],
  indexed: readonly string[] = revoked,
): Promise<string[]> {
  return [
    `list ${kvKeys.authTokenIndex(userId, "")}`,
    `delete ${kvKeys.auth(userId)}`,
    ...(await Promise.all(
      revoked.map(async (t) => `delete ${await authTokenKey(t)}`),
    )),
    ...(await Promise.all(
      indexed.map(async (t) => `delete ${await authTokenIndexKey(userId, t)}`),
    )),
  ];
}

/**
 * Pin a revoke's order in `trail` (#431): `userId`'s index is listed exactly
 * once, before every `token:` delete, and each of its `tokenidx:` deletes comes
 * after every `token:` delete — so a failed `token:` delete keeps every index
 * for the retry.
 */
export function expectRevokeIndexOrder(trail: string[], userId: string): void {
  const prefix = kvKeys.authTokenIndex(userId, "");
  const listAt = trail.indexOf(`list ${prefix}`);
  expect(trail.filter((e) => e === `list ${prefix}`)).toHaveLength(1);
  const positions = (start: string) =>
    trail.flatMap((e, i) => (e.startsWith(start) ? [i] : []));
  const tokenDeletes = positions(`delete ${kvKeys.authToken("")}`);
  for (const at of tokenDeletes) expect(at).toBeGreaterThan(listAt);
  for (const at of positions(`delete ${prefix}`))
    expect(at).toBeGreaterThan(Math.max(listAt, ...tokenDeletes));
}

/**
 * The userId `token:{hash(token)}` names, or `null` when the key is gone —
 * the "is this token still alive" probe that replaced reading `token:{token}`
 * as text. A malformed value reads as its raw `userId` field.
 */
export async function tokenOwner(
  kv: KVNamespace,
  token: string,
): Promise<string | null> {
  const record = await kv.get<AuthTokenRecord>(
    await authTokenKey(token),
    "json",
  );
  return record?.userId ?? null;
}

/** Whether `auth:{userId}`'s token list holds `token`'s hash — what "the account's current token" became (#425). */
export async function listsToken(
  kv: KVNamespace,
  userId: string,
  token: string,
): Promise<boolean> {
  const record = await kv.get<StoredAuthRecord>(kvKeys.auth(userId), "json");
  const hash = await hashAuthToken(token);
  return (record?.tokens ?? []).some((entry) => entry.hash === hash);
}

/**
 * Mint a real token through production `mintAuthToken` with `knownAuth: null`,
 * so `auth:{userId}` is REPLACED by a list holding only this token (an earlier
 * token's `token:` key stays readable but is no longer listed). Use it where a
 * suite needs production's TTLs and value shape rather than `seedAuthToken`'s
 * TTL-less fixture.
 */
export async function mintTestToken(
  kv: KVNamespace,
  userId: string,
): Promise<string> {
  return (await mintAuthToken(kv, userId, null)).token;
}

/**
 * Seed the PRE-#425 plaintext shape that the transition fallback still accepts:
 * `token:{token}` → userId (bare text) and `auth:{userId}` →
 * `{ token, createdAt, secretAt? }`. Production never writes this shape any
 * more; it is migrated by the account's next refresh or mint. No TTL, like
 * `seedAuthToken`. Returns the token.
 */
export async function seedLegacyAuthToken(
  kv: KVNamespace,
  userId: string,
  token: string,
  secretAt?: number,
): Promise<string> {
  const record = {
    token,
    createdAt: new Date().toISOString(),
    ...(secretAt !== undefined && { secretAt }),
  };
  await kv.put(kvKeys.authToken(token), userId);
  await kv.put(kvKeys.auth(userId), JSON.stringify(record));
  return token;
}
