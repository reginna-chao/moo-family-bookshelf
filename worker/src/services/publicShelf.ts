/**
 * Public-shelf snapshot writes + the public-shelf list resolver — shared by the
 * `user` and `publicShelf` route modules. Both live here rather than in
 * `routes/publicShelf.ts` because a route module must never import business
 * logic from a SIBLING route module (lint-enforced); logic needed by two or
 * more routes belongs in `services/`.
 */
import {
  kvKeys,
  BoolFlag,
  KV_MIN_TTL_SECONDS,
  type BookEntry,
  type PublicShelf,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
  type UserBooksRecord,
} from "../kv/schema";
import { sanitizeCoverUrl, sanitizeReadmooUrl } from "../utils/validation";

/**
 * Where a resolved shelf list came from:
 * - `pointer`: the `publicshelves:{userId}` key (migrated user).
 * - `legacy`: the `user:{userId}.publicSharing` field (not migrated yet).
 * - `none`: neither exists — the user has never created a public shelf.
 */
export type PublicShelvesSource = "pointer" | "legacy" | "none";

export interface ResolvedPublicShelves {
  shelves: PublicShelf[];
  source: PublicShelvesSource;
}

/**
 * Single source of truth for the lazy-migration fallback rule. PURE on purpose:
 * callers fetch the two KV values themselves, so a caller that needs both can
 * read them in parallel while the public read path can stay pointer-first and
 * touch `user:{userId}` only on a pointer miss.
 *
 * A non-null pointer record is ALWAYS authoritative — including when its
 * `shelves` array is empty, which means "migrated, all shelves deleted". Never
 * fall back past it, or deleting the last shelf would resurrect the legacy list.
 *
 * The `Array.isArray` checks are the "validate at system boundaries" guard for
 * first-hand KV data: both inputs are `kv.get(..., "json")` casts that nothing
 * validates, and this runs on the PUBLIC read path, so a corrupted record must
 * fail CLOSED (empty list ⇒ 404) instead of throwing a TypeError into a 500.
 * Container shape only — element fields (e.g. `expiresAt`) stay unvalidated;
 * see the liveness guard's monotonic comparison in `routes/publicShelf.ts`.
 */
export function resolvePublicShelves(
  pointer: PublicShelvesRecord | null,
  legacy: Pick<UserBooksRecord, "publicSharing"> | null,
): ResolvedPublicShelves {
  if (pointer) {
    // A corrupted pointer still WINS — falling past it would resurrect the
    // legacy list — it just degrades to "no shelves" instead of throwing.
    const shelves = Array.isArray(pointer.shelves) ? pointer.shelves : [];
    return { shelves, source: "pointer" };
  }
  const legacyShelves = legacy?.publicSharing?.shelves;
  if (Array.isArray(legacyShelves)) {
    return { shelves: legacyShelves, source: "legacy" };
  }
  return { shelves: [], source: "none" };
}

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

/**
 * The single chokepoint for `public:{shareToken}` snapshot contents — the
 * books-path refresh in `routes/user.ts` AND the create / update / reset-token
 * handlers in `routes/publicShelf.ts` all funnel through here. That is why both
 * attacker-controlled URL fields, `coverUrl` and `readmooUrl`, are re-sanitized
 * at this point rather than trusted from the `user:{userId}` record: the shelf
 * handlers hand over a raw KV read, so a record poisoned before the Readmoo
 * domain whitelist existed could otherwise mint a fresh snapshot that beacons
 * (cover) or phishes (book link) anonymous visitors, even if its owner never
 * syncs books again.
 */
function buildSnapshot(
  userId: string,
  shelf: PublicShelf,
  books: BookEntry[],
): PublicShelfSnapshot {
  return {
    userId,
    shelfId: shelf.shelfId,
    title: shelf.title,
    books: sharedBooks(books).map((b) => ({
      ...b,
      coverUrl: sanitizeCoverUrl(b.coverUrl),
      readmooUrl: sanitizeReadmooUrl(b.readmooUrl),
    })),
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
