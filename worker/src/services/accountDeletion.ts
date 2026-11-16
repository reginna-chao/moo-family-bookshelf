/** Ordered KV teardown of `DELETE /api/user/:id` (#462) and its mark-driven settling (#468): a failed stage leaves what
 *  a retry needs, and the sweep finishes what is left. Order and guarantees: docs/architecture.md → 家庭成員的授權與移除. */
import {
  getAccountDeletingMark,
  putAccountDeletingMark,
} from "../kv/accountDeleting";
import {
  deleteAuthRecord,
  deleteAuthTokenKey,
  putAccountDeletedMark,
} from "../kv/auth";
import { deleteAccountSettings } from "../kv/accountSettings";
import { deleteMemberFamilyId } from "../kv/families";
import { deleteNewBookDefault } from "../kv/newBookDefault";
import {
  deletePublicShelves,
  deletePublicSnapshot,
  getPublicShelves,
} from "../kv/publicShelves";
import {
  ACCOUNT_RECREATE_COOLDOWN_MS,
  kvKeys,
  type AccountDeletingMark,
  type AuthRecord,
  type PublicShelvesRecord,
} from "../kv/schema";
import { deleteUserBooksRecord } from "../kv/users";
import { deleteOtpRecord, deleteVerifyRecord } from "../kv/verify";
import { readAuthRecord } from "./authRecord";
import {
  deleteIndexKeys,
  listIndexHashesUpTo,
  listRevocableIndexHashes,
} from "./authTokens";
import { resolvePublicShelves } from "./publicShelf";

/** Index entries one wipe processes per account; with the `auth:` list (≤ 5) a sweep run stays under 1,000 KV operations. */
export const MAX_SETTLE_INDEX_HASHES = 10;

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

/** The mark's share tokens; the value is an unvalidated cast, so a malformed one reads as none. */
function markShareTokens(mark: AccountDeletingMark | null): string[] {
  const tokens: unknown = mark?.shareTokens;
  return Array.isArray(tokens)
    ? tokens.filter((t): t is string => typeof t === "string")
    : [];
}

/** Start the deletion: the mark goes first, carrying the tokens an earlier attempt knew (`publicshelves:` may be gone by now). */
async function writeDeletingMark(
  kv: KVNamespace,
  userId: string,
  publicTokens: readonly string[],
): Promise<void> {
  const previous = await getAccountDeletingMark(kv, userId);
  await putAccountDeletingMark(kv, userId, {
    startedAt: Date.now(),
    shareTokens: [...new Set([...markShareTokens(previous), ...publicTokens])],
  });
}

/** Best effort: a shelf created after the route read `publicTokens` loses its snapshot here, before the list that names it goes. */
async function deleteShelfList(
  kv: KVNamespace,
  userId: string,
  publicTokens: readonly string[],
): Promise<void> {
  const known = new Set(publicTokens);
  const late = resolvePublicShelves(await getPublicShelves(kv, userId), null)
    .shelves.map((shelf) => shelf.shareToken)
    .filter((token) => !known.has(token));
  await Promise.all(late.map((token) => deletePublicSnapshot(kv, token)));
  await deletePublicShelves(kv, userId);
}

/**
 * Delete one account's keys in sequential stages, each awaited before the next: the
 * deleting mark → public snapshots → `user:` / `newbookdefault:` / `settings:` / `otp:` → late
 * snapshots and `publicshelves:` → other tokens → `member:` → deleted mark → `auth:` →
 * `verify:` → presented `token:` and its index. Stages throw on a KV failure and leave
 * the later keys in place, except the two fail-open ones: the deleted mark and the index
 * deletes. The deleting mark is never cleared here: once written the deletion always
 * finishes, by the owner's retry or by the sweep (#468). Reads the previous mark, the
 * shelf list and the token index (callers hand in the rest) and answers nothing: the
 * route owns the response.
 */
export async function deleteAccountKeys(
  kv: KVNamespace,
  userId: string,
  keys: AccountDeletionKeys,
): Promise<void> {
  const { publicTokens, auth, presentedHash } = keys;

  await writeDeletingMark(kv, userId, publicTokens);
  await Promise.all(
    publicTokens.map((token) => deletePublicSnapshot(kv, token)),
  );
  await Promise.all([
    deleteUserBooksRecord(kv, userId),
    deleteNewBookDefault(kv, userId),
    deleteAccountSettings(kv, userId),
    deleteOtpRecord(kv, userId),
  ]);
  await deleteShelfList(kv, userId, publicTokens);
  await revokeOtherTokens(kv, userId, auth, presentedHash);
  await deleteMemberFamilyId(kv, userId);
  await markAccountDeleted(kv, presentedHash, userId);
  await deleteAuthRecord(kv, userId);
  await deleteVerifyRecord(kv, userId);
  await deleteAuthTokenKey(kv, presentedHash);
  await deleteIndexKeys(kv, userId, [presentedHash]);
}

/**
 * Whether a token was minted after the mark was written. Only protects a re-created
 * account from a mark some colo still caches; it does NOT prove a re-creation, because
 * a racing `PUT /verify` or refresh can mint a newer token too. `null` or an
 * unparseable `createdAt` reads as an old token. Only the guard uses it.
 */
export function isTokenAfterDeletion(
  createdAt: string | null,
  mark: AccountDeletingMark,
): boolean {
  return createdAt !== null && Date.parse(createdAt) > mark.startedAt;
}

/** Read first, delete only what exists: nothing left means no delete operation is spent. */
async function deleteIfPresent(kv: KVNamespace, key: string): Promise<void> {
  if ((await kv.get(key)) !== null) await kv.delete(key);
}

/** Snapshots, then `publicshelves:` only if they all went: the list may be the last place naming a failed token's snapshot.
 *  Never rejects. `false` = incomplete. */
async function wipeShelfKeys(
  kv: KVNamespace,
  userId: string,
  mark: AccountDeletingMark,
): Promise<boolean> {
  let pointer: PublicShelvesRecord | null = null;
  let pointerRead = true;
  try {
    pointer = await getPublicShelves(kv, userId);
  } catch {
    pointerRead = false;
  }
  const tokens = new Set(markShareTokens(mark));
  for (const shelf of resolvePublicShelves(pointer, null).shelves) {
    tokens.add(shelf.shareToken);
  }

  const snapshots = await Promise.allSettled(
    [...tokens].map((token) => deleteIfPresent(kv, kvKeys.publicShelf(token))),
  );
  if (!pointerRead || snapshots.some((r) => r.status === "rejected")) {
    return false;
  }
  if (pointer === null) return true;
  try {
    await deletePublicShelves(kv, userId);
    return true;
  } catch {
    return false;
  }
}

/** The shelf keys and the other personal keys, independent of each other: one failure does not stop the rest. `false` = incomplete. */
async function wipePersonalKeys(
  kv: KVNamespace,
  userId: string,
  mark: AccountDeletingMark,
): Promise<boolean> {
  const [shelvesOk, personal] = await Promise.all([
    wipeShelfKeys(kv, userId, mark),
    Promise.allSettled([
      deleteIfPresent(kv, kvKeys.user(userId)),
      deleteIfPresent(kv, kvKeys.newBookDefault(userId)),
      deleteIfPresent(kv, kvKeys.accountSettings(userId)),
      deleteIfPresent(kv, kvKeys.otp(userId)),
      deleteIfPresent(kv, kvKeys.member(userId)),
    ]),
  ]);
  return shelvesOk && personal.every((r) => r.status === "fulfilled");
}

/** The account's index hashes for a wipe, at most `MAX_SETTLE_INDEX_HASHES`. `complete` is false when the listing
 *  failed or stopped at that cap: tokens may remain unlisted. */
async function listHashesForWipe(
  kv: KVNamespace,
  userId: string,
): Promise<{ indexed: string[]; complete: boolean }> {
  try {
    const { hashes, capped } = await listIndexHashesUpTo(
      kv,
      userId,
      MAX_SETTLE_INDEX_HASHES,
    );
    if (capped) {
      console.error("AUTH_TOKEN_INDEX_CAPPED", { listed: hashes.length });
    }
    return { indexed: hashes, complete: !capped };
  } catch {
    return { indexed: [], complete: false };
  }
}

/** Every token the index, the `auth:` list or the caller names: deleted mark first so a retry gets `ACCOUNT_DELETED`.
 *  A failed token keeps its index for the next pass, as a capped listing leaves the rest. `false` = incomplete. */
async function wipeTokenKeys(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord | null,
  extraTokenHashes: readonly string[],
): Promise<boolean> {
  const { indexed, complete } = await listHashesForWipe(kv, userId);

  const hashes = [
    ...new Set([
      ...indexed,
      ...(auth?.tokens ?? []).map((entry) => entry.hash),
      ...extraTokenHashes,
    ]),
  ];
  const results = await Promise.allSettled(
    hashes.map(async (hash) => {
      await markAccountDeleted(kv, hash, userId);
      await deleteAuthTokenKey(kv, hash);
    }),
  );
  const failed = new Set(
    hashes.filter((_, index) => results[index].status === "rejected"),
  );
  await deleteIndexKeys(
    kv,
    userId,
    indexed.filter((hash) => !failed.has(hash)),
  );
  return complete && failed.size === 0;
}

/** `auth:` before `verify:` (.claude/rules/backend.md → Route handler invariants): an unread or undeleted `auth:` keeps
 *  `verify:` in place, because a `secretAt` with no record answers every later join 403. `false` = incomplete. */
async function wipeAuthThenVerify(
  kv: KVNamespace,
  userId: string,
  auth: AuthRecord | null | undefined,
): Promise<boolean> {
  try {
    if (auth === undefined) return false;
    if (auth !== null) await deleteAuthRecord(kv, userId);
    await deleteIfPresent(kv, kvKeys.verify(userId));
    return true;
  } catch {
    return false;
  }
}

/** `auth:{userId}` for a wipe: the caller's read when given, else read here; `undefined` = the read failed. */
async function authForWipe(
  kv: KVNamespace,
  userId: string,
  known: AuthRecord | null | undefined,
): Promise<AuthRecord | null | undefined> {
  if (known !== undefined) return known;
  try {
    return await readAuthRecord(kv, userId);
  } catch {
    return undefined;
  }
}

/**
 * Remove whatever an in-flight write put back after a deletion started (#468): public
 * snapshots (the mark's tokens and the current list), `user:`, `publicshelves:`,
 * `newbookdefault:`, `settings:`, `otp:`, `member:`, then every token, then `auth:`, then `verify:`.
 * Every key is read first and deleted only when present, except a `token:` key, whose
 * delete follows its deleted mark. One key's failure does not stop the others, because
 * KV's one-write-per-second limit on a key is likely here. Three skips keep what the next
 * pass needs: a failed snapshot delete skips `publicshelves:`; an unfinished token pass (a
 * failed delete, or an index listing that failed or stopped at `MAX_SETTLE_INDEX_HASHES`)
 * skips `auth:` and `verify:`; a failed `auth:` delete skips `verify:`. Throws `account
 * wipe incomplete` at the end if anything failed or was skipped, so a wipe never reports
 * success with a live token; the message and the logs name no key (#357). Never touches
 * the mark: that is the caller's call.
 */
export async function wipeAccountData(
  kv: KVNamespace,
  userId: string,
  mark: AccountDeletingMark,
  options: {
    auth?: AuthRecord | null;
    extraTokenHashes?: readonly string[];
  } = {},
): Promise<void> {
  const personalOk = await wipePersonalKeys(kv, userId, mark);
  const auth = await authForWipe(kv, userId, options.auth);
  const tokensOk = await wipeTokenKeys(
    kv,
    userId,
    auth ?? null,
    options.extraTokenHashes ?? [],
  );
  const authOk = tokensOk && (await wipeAuthThenVerify(kv, userId, auth));
  if (!personalOk || !authOk) {
    throw new Error("account wipe incomplete");
  }
}

/**
 * For a create / manual join past its earlier refusals, before any write: what a pending
 * deletion means for it. `"none"` = no mark, or `auth.secretAt` is newer than the mark:
 * nothing is wiped, and the caller's stale-record check still applies. `"cooling"` = the
 * mark is younger than `ACCOUNT_RECREATE_COOLDOWN_MS`; nothing is touched and the caller
 * answers 409. `"wiped"` = the leftovers are gone and the mark STAYS: the caller treats
 * everything it read as stale, must not re-read the mark in this request, and deletes it
 * right before its mint, because only a real admission ends a deletion. A read or wipe
 * failure throws, which answers 500 with nothing new written. Only the Worker writes the
 * mark, so `startedAt` is not validated: a non-numeric string is simply not cooling.
 */
export async function settleDeletionForAdmission(
  kv: KVNamespace,
  userId: string,
): Promise<"none" | "cooling" | "wiped"> {
  const mark = await getAccountDeletingMark(kv, userId);
  if (mark === null) return "none";
  if (Date.now() - mark.startedAt < ACCOUNT_RECREATE_COOLDOWN_MS) {
    return "cooling";
  }
  // A colo holding a stale mark and a stale `verify:` miss must not bypass a PIN set after the deletion began: no
  // wipe, so the caller's stale-record check answers 403. See docs/architecture.md → 已接受的殘餘風險.
  const auth = await readAuthRecord(kv, userId);
  if (auth?.secretAt !== undefined && auth.secretAt > mark.startedAt) {
    return "none";
  }
  await wipeAccountData(kv, userId, mark, { auth });
  return "wiped";
}

/**
 * For a create / join whose token is already minted: `true` = a deletion started while
 * it ran, so it was wiped (the mark stays) and the caller must refuse. A read failure
 * logs and reads as `false`, leaving the rest to the sweep; a wipe failure logs and
 * still answers `true`.
 */
export async function deletionStartedDuring(
  kv: KVNamespace,
  userId: string,
): Promise<boolean> {
  let mark: AccountDeletingMark | null;
  try {
    mark = await getAccountDeletingMark(kv, userId);
  } catch {
    console.error("ACCOUNT_DELETION_GUARD_FAILED");
    return false;
  }
  if (mark === null) return false;
  try {
    await wipeAccountData(kv, userId, mark);
  } catch {
    console.error("ACCOUNT_DELETION_GUARD_FAILED");
  }
  return true;
}
