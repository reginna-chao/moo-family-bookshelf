/** Thin data access for `settings:{userId}` — the settings that follow the account (#460). Single writer:
 *  `routes/userSettings.ts`. Rationale: .claude/rules/backend.md → KV Key Patterns (account settings). */
import { toAccountSettingsRecord } from "../services/accountSettings";
import { kvKeys, type AccountSettingsRecord } from "./schema";

/**
 * Read `settings:{userId}` (persistent, no TTL), rebuilt field by field: a
 * missing key, unparseable JSON, a non-object or an invalid field all read as
 * absent, so the result is `{}` at worst. Read as text, so corruption never
 * throws (a KV failure still does).
 */
export async function readAccountSettings(
  kv: KVNamespace,
  userId: string,
): Promise<AccountSettingsRecord> {
  const raw = await kv.get(kvKeys.accountSettings(userId));
  if (raw === null) return {};
  try {
    return toAccountSettingsRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Write `settings:{userId}` as the whole record. No TTL — a personal setting
 * that survives family changes (security-ux Invariant 5).
 * Caller: `PATCH /api/user/:id/settings` only.
 */
export async function putAccountSettings(
  kv: KVNamespace,
  userId: string,
  record: AccountSettingsRecord,
): Promise<void> {
  await kv.put(kvKeys.accountSettings(userId), JSON.stringify(record));
}

/** Delete `settings:{userId}` — whole-account teardown only. */
export async function deleteAccountSettings(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.accountSettings(userId));
}
