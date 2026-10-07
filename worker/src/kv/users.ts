/** Thin data access (#163) for `user:{userId}` — the personal book list + sharing settings.
 *  Rationale: .claude/rules/backend.md → Project Structure ("Layering, second rule"). */
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
