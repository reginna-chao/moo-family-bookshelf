/** Thin data access (#163) for `publicshelves:{userId}` (single writer: `routes/publicShelf.ts`) and
 *  `public:{shareToken}` (no put). Rationale: .claude/rules/backend.md → KV Key Patterns (public shelves). */
import {
  kvKeys,
  type PublicShelfSnapshot,
  type PublicShelvesRecord,
} from "./schema";

/**
 * Read the pointer list `publicshelves:{userId}`. Persistent, no TTL. `null`
 * means the user has not migrated yet — callers fall back to the legacy
 * `user:{userId}.publicSharing` field via `resolvePublicShelves`.
 */
export async function getPublicShelves(
  kv: KVNamespace,
  userId: string,
): Promise<PublicShelvesRecord | null> {
  return kv.get<PublicShelvesRecord>(kvKeys.publicShelves(userId), "json");
}

/**
 * Write the pointer list `publicshelves:{userId}` as JSON. No TTL.
 *
 * Callers: the four public-shelf write handlers in `routes/publicShelf.ts`,
 * and nothing else — see .claude/rules/backend.md → KV Key Patterns (public shelves).
 */
export async function putPublicShelves(
  kv: KVNamespace,
  userId: string,
  record: PublicShelvesRecord,
): Promise<void> {
  await kv.put(kvKeys.publicShelves(userId), JSON.stringify(record));
}

/**
 * Delete `publicshelves:{userId}` — whole-account teardown only. A wipe, not a
 * list write: it can resurrect nothing.
 */
export async function deletePublicShelves(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.publicShelves(userId));
}

/**
 * Read the published snapshot `public:{shareToken}`. TTL is set by the writer
 * (user-configured shelf lifetime, or none for a permanent shelf), so a `null`
 * here can equally mean "expired" or "never existed" — the public read handler
 * answers both identically.
 */
export async function getPublicSnapshot(
  kv: KVNamespace,
  token: string,
): Promise<PublicShelfSnapshot | null> {
  return kv.get<PublicShelfSnapshot>(kvKeys.publicShelf(token), "json");
}

/** Delete `public:{shareToken}` — revoke / rotate the published snapshot. */
export async function deletePublicSnapshot(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  await kv.delete(kvKeys.publicShelf(token));
}
