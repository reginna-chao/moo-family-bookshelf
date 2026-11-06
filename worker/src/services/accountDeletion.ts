/** Ordered KV teardown of `DELETE /api/user/:id` (#462): a failed stage leaves what a retry needs.
 *  Order and retry behaviour: docs/architecture.md → 家庭成員的授權與移除. */
import {
  deleteAuthRecord,
  deleteAuthTokenKey,
  putAccountDeletedMark,
} from "../kv/auth";
import { deleteMemberFamilyId } from "../kv/families";
import { deleteNewBookDefault } from "../kv/newBookDefault";
import { deletePublicShelves, deletePublicSnapshot } from "../kv/publicShelves";
import type { AuthRecord } from "../kv/schema";
import { deleteUserBooksRecord } from "../kv/users";
import { deleteOtpRecord, deleteVerifyRecord } from "../kv/verify";
import { deleteIndexKeys, listRevocableIndexHashes } from "./authTokens";

export interface AccountDeletionKeys {
  publicTokens: readonly string[];
  auth: AuthRecord | null;
  presentedHash: string;
}

/** Every other token of the account, listed or indexed; the presented token and its index stay for the retry. */
async function revokeOtherTokens(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord | null,
  presentedHash: string,
): Promise<void> {
  const { hashes, capped } = await listRevocableIndexHashes(kv, userId);
  const indexed = hashes.filter((hash) => hash !== presentedHash);
  const others = new Set((auth?.tokens ?? []).map((entry) => entry.hash));
  for (const hash of indexed) others.add(hash);
  others.delete(presentedHash);

  await Promise.all([...others].map((hash) => deleteAuthTokenKey(kv, hash)));
  await deleteIndexKeys(kv, userId, indexed);

  if (capped) {
    console.error("AUTH_TOKEN_INDEX_CAPPED", { listed: hashes.length });
    throw new Error("account deletion: token index capped");
  }
}

/** Runs before the `auth:` delete, so refresh's TTL-gap branch finds the mark and refuses to mint (`renewPresentedAuthToken`).
 *  Fail-open, event name only: with no `err` logged, this key's token hash cannot reach a log line (#357). */
async function markAccountDeleted(
  kv: KVNamespace,
  presentedHash: string,
  userId: string,
): Promise<void> {
  try {
    await putAccountDeletedMark(kv, presentedHash, userId);
  } catch {
    console.error("ACCOUNT_DELETED_MARK_FAILED");
  }
}

/**
 * Delete one account's keys in nine sequential stages, each awaited before the next:
 * public snapshots → `user:` / `newbookdefault:` / `otp:` → `publicshelves:` → other
 * tokens → `member:` → deleted mark → `auth:` → `verify:` → presented `token:` and its
 * index. Stages throw on a KV failure and leave the later keys in place, except the two
 * fail-open ones: the mark and the index deletes. Reads nothing beyond the token index
 * (callers hand in what they read) and answers nothing: the route owns the response.
 */
export async function deleteAccountKeys(
  kv: KVNamespace,
  userId: string,
  keys: AccountDeletionKeys,
): Promise<void> {
  const { publicTokens, auth, presentedHash } = keys;

  await Promise.all(
    publicTokens.map((token) => deletePublicSnapshot(kv, token)),
  );
  await Promise.all([
    deleteUserBooksRecord(kv, userId),
    deleteNewBookDefault(kv, userId),
    deleteOtpRecord(kv, userId),
  ]);
  await deletePublicShelves(kv, userId);
  await revokeOtherTokens(kv, userId, auth, presentedHash);
  await deleteMemberFamilyId(kv, userId);
  await markAccountDeleted(kv, presentedHash, userId);
  await deleteAuthRecord(kv, userId);
  await deleteVerifyRecord(kv, userId);
  await deleteAuthTokenKey(kv, presentedHash);
  await deleteIndexKeys(kv, userId, [presentedHash]);
}
