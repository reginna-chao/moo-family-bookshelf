/** Thin data access (#468) for `token:deleting:{userId}`, the mark an account deletion leaves until its data stays gone.
 *  One KV op each, no validation. See docs/architecture.md → 家庭成員的授權與移除. */
import {
  ACCOUNT_DELETING_MARK_TTL_SECONDS,
  kvKeys,
  type AccountDeletingMark,
} from "./schema";

/** Read `token:deleting:{userId}` as JSON, unvalidated. `null` = no deletion in progress, or the mark expired. */
export async function getAccountDeletingMark(
  kv: KVNamespace,
  userId: string,
): Promise<AccountDeletingMark | null> {
  return kv.get<AccountDeletingMark>(kvKeys.accountDeleting(userId), "json");
}

/** Write `token:deleting:{userId}` with TTL `ACCOUNT_DELETING_MARK_TTL_SECONDS`. */
export async function putAccountDeletingMark(
  kv: KVNamespace,
  userId: string,
  mark: AccountDeletingMark,
): Promise<void> {
  await kv.put(kvKeys.accountDeleting(userId), JSON.stringify(mark), {
    expirationTtl: ACCOUNT_DELETING_MARK_TTL_SECONDS,
  });
}

/** Delete `token:deleting:{userId}` — only the sweep's retirement and a re-creation that is really admitted. */
export async function deleteAccountDeletingMark(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.accountDeleting(userId));
}

/** List ONE page of mark keys (up to 1,000), returned as-is: the sweep reads key names only. */
export async function listAccountDeletingPage(
  kv: KVNamespace,
): Promise<KVNamespaceListResult<unknown>> {
  return kv.list({ prefix: kvKeys.accountDeleting("") });
}
