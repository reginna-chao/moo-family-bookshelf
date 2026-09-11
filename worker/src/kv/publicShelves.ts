/**
 * Data access for the public-shelf key family: the pointer list
 * `publicshelves:{userId}` and the published snapshot `public:{shareToken}`.
 *
 * WHY this module exists (#163): one chokepoint per key family, so route
 * handlers never build a KV key or call `c.env.KV` themselves (lint-enforced by
 * the `src/routes/**` override in `worker/eslint.config.js`). Thin by design —
 * one KV operation per function, `"json"` reads keep their unvalidated cast,
 * puts keep `JSON.stringify`, and the counting Proxy from
 * `middleware/kvOpCounting.ts` flows through as the `kv` parameter, so the
 * per-request `kv_ops` accounting is unchanged.
 *
 * SINGLE-WRITER INVARIANT, and where it now lives. `publicshelves:{userId}` has
 * exactly one writer domain — the four public-shelf write handlers in
 * `routes/publicShelf.ts` (plus the whole-account wipe in `routes/user.ts`,
 * which only ever DELETES it). {@link putPublicShelves} is exported, so that
 * property is no longer guaranteed by "nothing shared offers a put"; it is
 * pinned by a tripwire test that asserts `routes/publicShelf.ts` is the only
 * route module importing it (`worker/tests/unit/kvAccessBoundary.test.ts`).
 * The books / family-prefs hot paths must keep READING this key and never
 * writing it — that is what stops a stale-read books save from rolling a
 * revoked share token back to life.
 *
 * NOTE: `public:{shareToken}` has no `put` here on purpose. Every snapshot
 * write goes through `writePublicSnapshot` in `services/publicShelf.ts`, which
 * owns the `buildSnapshot` URL-whitelist chokepoint and the dynamic TTL
 * (a remaining lifetime under `KV_MIN_TTL_SECONDS` deletes instead of putting).
 * Offering a bare snapshot put here would be a way around both.
 */
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
 * and nothing else — see the single-writer note in this module's header.
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
