/**
 * Shared auth-token seeding for tests.
 *
 * An auth token has TWO KV halves with different consumers:
 * - `token:{token}` → userId — the ONLY key `middleware/auth.ts` reads to
 *   authenticate a request.
 * - `auth:{userId}` → `AuthRecord` — the token currently issued to that user;
 *   read only by the issue/rotate/delete paths (`generateAuthToken`,
 *   `getOrGenerateAuthToken`, `deleteAuthToken`).
 *
 * A token-only seed therefore still authenticates; what it breaks is token
 * rotation and cleanup (e.g. `/api/auth/refresh` reusing the same token,
 * account deletion clearing the reverse key). Seeding both halves matches the
 * state a really-issued token is in, so the pair is written here in one place
 * instead of being re-typed per suite.
 *
 * Keys are built through the production `kvKeys` helpers on purpose: if the
 * `token:` / `auth:` prefixes in `src/kv/schema.ts` ever change, these seeds
 * follow automatically and keep pointing at the keys production actually
 * reads, instead of seeding dead keys and silently asserting 401s. Never
 * inline the raw key strings here.
 *
 * Unlike production writes, these seeds carry no `expirationTtl` (the old
 * inline fixtures did not either). A test that asserts auth-key TTLs must go
 * through the production `generateAuthToken()` instead.
 *
 * Tests that deliberately seed only ONE half (only `token:{token}`, or an
 * `auth:` record with no matching token key) must keep doing that inline —
 * that asymmetry is the thing under test, not a case for this helper.
 */

import { kvKeys, type AuthRecord } from "../../src/kv/schema";

/**
 * Deterministic 64-char auth token derived from a 64-hex userId.
 *
 * Test convention only — production tokens are 32 random bytes hex-encoded
 * (`crypto.getRandomValues` in `middleware/auth.ts`). Deriving keeps a suite's
 * token readable next to its userId. Distinctness holds only while the FIRST
 * 32 chars of two userIds differ — true for the fixed-nibble ids in
 * `helpers/ids.ts`, but NOT for `makeUserId()` ids (they share an all-`0`
 * prefix, so every derived token collides); pass an explicit `opts.token`
 * when seeding several `makeUserId()` users.
 */
export function tokenFor(userId: string): string {
  return userId.slice(0, 32).repeat(2);
}

/** Overrides for callers that need a specific token or a fixed issue time. */
export interface SeedAuthTokenOptions {
  /** Use this exact token instead of `tokenFor(userId)`. */
  token?: string;
  /**
   * ISO timestamp stored as `AuthRecord.createdAt`. Defaults to now; pass a
   * fixed past value where the age of the record is what the test is about
   * (e.g. proving `/api/auth/refresh` replaces an old record).
   */
  createdAt?: string;
}

/**
 * Seed KV with a complete, valid auth-token pair for `userId` and return the
 * token, ready to send as `Authorization: Bearer <token>`.
 */
export async function seedAuthToken(
  kv: KVNamespace,
  userId: string,
  opts?: SeedAuthTokenOptions,
): Promise<string> {
  const token = opts?.token ?? tokenFor(userId);
  const record: AuthRecord = {
    token,
    createdAt: opts?.createdAt ?? new Date().toISOString(),
  };
  await kv.put(kvKeys.authToken(token), userId);
  await kv.put(kvKeys.auth(userId), JSON.stringify(record));
  return token;
}
