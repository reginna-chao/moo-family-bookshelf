/**
 * Data access for the family key family: `family:{familyId}`,
 * `member:{userId}` and `kicked:{familyId}:{userId}`.
 *
 * WHY this module exists (#163): route handlers must not reach into KV
 * directly. One chokepoint per key family means the key spelling, the value
 * encoding and the TTL of each key live in exactly one place, so a route can
 * neither invent a key nor forget a TTL. Routes never import `kvKeys` —
 * lint-enforced by the `src/routes/**` override in `worker/eslint.config.js`.
 *
 * Deliberately a THIN accessor layer, not a repository: every function is one
 * KV operation with the same semantics the handlers had inline. In particular
 * `"json"` reads keep their unvalidated cast (nothing here validates the parsed
 * value) and puts keep `JSON.stringify` exactly as before, so the stored bytes,
 * the operation count and the per-request `kv_ops` log line are unchanged — the
 * same `KVNamespace` (the counting Proxy from `middleware/kvOpCounting.ts`)
 * flows through as the first parameter.
 */
import {
  kvKeys,
  KICKED_TOMBSTONE_TTL_SECONDS,
  type FamilyRecord,
  type KickedRecord,
  type RawFamilyRecord,
} from "./schema";

/**
 * Read `family:{familyId}`. No TTL on read; the value may predate fields added
 * after release, hence the RAW shape — callers pass it through
 * `normalizeFamilyRecord`.
 */
export async function getFamilyRecord(
  kv: KVNamespace,
  familyId: string,
): Promise<RawFamilyRecord | null> {
  return kv.get<RawFamilyRecord>(kvKeys.family(familyId), "json");
}

/** Write `family:{familyId}` as JSON. No TTL (configurable at the namespace). */
export async function putFamilyRecord(
  kv: KVNamespace,
  familyId: string,
  record: FamilyRecord | RawFamilyRecord,
): Promise<void> {
  await kv.put(kvKeys.family(familyId), JSON.stringify(record));
}

/** Delete `family:{familyId}` — the family-dissolve write. */
export async function deleteFamilyRecord(
  kv: KVNamespace,
  familyId: string,
): Promise<void> {
  await kv.delete(kvKeys.family(familyId));
}

/**
 * Read the reverse lookup `member:{userId}` → familyId. Plain string value, no
 * JSON. `null` means "not in any family" (or an orphaned key already cleaned).
 */
export async function getMemberFamilyId(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  return kv.get(kvKeys.member(userId));
}

/**
 * Write `member:{userId}` → familyId. Stored as a PLAIN STRING, not JSON — the
 * value is read back with a bare `get` and compared to a familyId directly.
 * No TTL (follows the family record).
 */
export async function putMemberFamilyId(
  kv: KVNamespace,
  userId: string,
  familyId: string,
): Promise<void> {
  await kv.put(kvKeys.member(userId), familyId);
}

/** Delete `member:{userId}` — leave / removal / orphan cleanup. */
export async function deleteMemberFamilyId(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.member(userId));
}

/**
 * Does `kicked:{familyId}:{userId}` exist? PRESENCE only — the join gate never
 * parses the value (both fields are diagnostic), so a corrupted or legacy-shaped
 * tombstone still blocks the rejoin. Exactly one KV `get`.
 */
export async function hasKickedTombstone(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const kicked = await kv.get(kvKeys.kicked(familyId, userId));
  return kicked !== null;
}

/**
 * Write the owner-initiated removal tombstone `kicked:{familyId}:{userId}` with
 * TTL `KICKED_TOMBSTONE_TTL_SECONDS` (6h).
 *
 * Throws on failure like any other put: the fail-open policy and the
 * "only when the owner removes ANOTHER member" discriminator belong to the
 * caller (`writeKickedTombstone` in `routes/family.ts`), not here.
 */
export async function putKickedTombstone(
  kv: KVNamespace,
  familyId: string,
  userId: string,
  record: KickedRecord,
): Promise<void> {
  await kv.put(kvKeys.kicked(familyId, userId), JSON.stringify(record), {
    expirationTtl: KICKED_TOMBSTONE_TTL_SECONDS,
  });
}

/**
 * Delete `kicked:{familyId}:{userId}` — the owner's un-kick remedy. Idempotent
 * and read-free: deleting an absent key is a no-op, so the caller can answer
 * identically whether or not a tombstone existed.
 */
export async function deleteKickedTombstone(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.kicked(familyId, userId));
}
