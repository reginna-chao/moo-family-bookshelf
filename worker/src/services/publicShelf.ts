/**
 * Public-shelf snapshot writes — shared by the `user` and `publicShelf` route
 * modules. It lives here rather than in `routes/publicShelf.ts` because a route
 * module must never import business logic from a SIBLING route module; logic
 * needed by two or more routes belongs in `services/`.
 */
import {
  kvKeys,
  BoolFlag,
  KV_MIN_TTL_SECONDS,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
} from "../kv/schema";

function sharedBooks(books: BookEntry[]): BookEntry[] {
  return books.filter((b) => b.isShared === BoolFlag.TRUE);
}

/**
 * Remaining lifetime in seconds, or `undefined` when the shelf never expires.
 * Cloudflare KV rejects an `expirationTtl` below `KV_MIN_TTL_SECONDS`, so a
 * lifetime shorter than that minimum is treated as already expired (0) — the
 * caller then deletes the snapshot instead of putting one that KV would refuse.
 */
function remainingTtlSeconds(expiresAt: number | null): number | undefined {
  if (expiresAt === null) return undefined;
  const remaining = Math.floor((expiresAt - Date.now()) / 1000);
  return remaining >= KV_MIN_TTL_SECONDS ? remaining : 0;
}

function buildSnapshot(
  userId: string,
  shelf: PublicShelf,
  books: BookEntry[],
): PublicShelfSnapshot {
  return {
    userId,
    shelfId: shelf.shelfId,
    title: shelf.title,
    books: sharedBooks(books),
    createdAt: shelf.createdAt,
    expiresAt: shelf.expiresAt,
  };
}

export async function writePublicSnapshot(
  kv: KVNamespace,
  userId: string,
  shelf: PublicShelf,
  books: BookEntry[],
): Promise<void> {
  const ttl = remainingTtlSeconds(shelf.expiresAt);
  if (ttl === 0) {
    await kv.delete(kvKeys.publicShelf(shelf.shareToken));
    return;
  }
  const snapshot = buildSnapshot(userId, shelf, books);
  const opts: KVNamespacePutOptions = {};
  if (ttl !== undefined) opts.expirationTtl = ttl;
  await kv.put(
    kvKeys.publicShelf(shelf.shareToken),
    JSON.stringify(snapshot),
    opts,
  );
}
