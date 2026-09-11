/**
 * Data access for `user:{userId}` — the personal book list + sharing settings.
 *
 * WHY this module exists (#163): one chokepoint per key family, so route
 * handlers never build a KV key or call `c.env.KV` themselves (lint-enforced by
 * the `src/routes/**` override in `worker/eslint.config.js`).
 *
 * Thin by design: one KV operation per function, with the same semantics the
 * handlers had inline — the `"json"` read keeps its unvalidated cast, the put
 * keeps `JSON.stringify`, and the counting Proxy from
 * `middleware/kvOpCounting.ts` still flows through as the `kv` parameter, so
 * the per-request `kv_ops` accounting is unaffected.
 */
import { kvKeys, type UserBooksRecord } from "./schema";

/**
 * Read `user:{userId}`. Persistent key, no TTL. The parsed value is CAST, not
 * validated — a record written before a field existed simply lacks it.
 */
export async function getUserBooksRecord(
  kv: KVNamespace,
  userId: string,
): Promise<UserBooksRecord | null> {
  return kv.get<UserBooksRecord>(kvKeys.user(userId), "json");
}

/**
 * Write `user:{userId}` as JSON. No TTL — personal settings persist across
 * family changes (security-ux Invariant 5).
 */
export async function putUserBooksRecord(
  kv: KVNamespace,
  userId: string,
  record: UserBooksRecord,
): Promise<void> {
  await kv.put(kvKeys.user(userId), JSON.stringify(record));
}

/** Delete `user:{userId}` — whole-account teardown only. */
export async function deleteUserBooksRecord(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.user(userId));
}
