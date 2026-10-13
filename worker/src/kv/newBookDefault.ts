/** Thin data access for `newbookdefault:{userId}` — the per-user 新書預設開放 setting (#238). Single writer:
 *  `routes/userNewBookDefault.ts`. Rationale: .claude/rules/backend.md → KV Key Patterns (new-book default). */
import { BoolFlag, kvKeys, type NewBookDefaultRecord } from "./schema";

/** Classify a stored raw value: exactly `{ newBookDefaultShared: 0 | 1 }` ⇒ that flag, anything else ⇒ FALSE. */
function parseStoredFlag(raw: string): BoolFlag {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return BoolFlag.FALSE;
  }
  if (typeof parsed !== "object" || parsed === null) return BoolFlag.FALSE;
  const flag = (parsed as Partial<NewBookDefaultRecord>).newBookDefaultShared;
  return flag === BoolFlag.TRUE ? BoolFlag.TRUE : BoolFlag.FALSE;
}

/**
 * Read `newbookdefault:{userId}` (persistent, no TTL), telling absence apart:
 * `null` when the key does not exist, otherwise the stored flag — an
 * unreadable value or anything but exactly `1` reads as `BoolFlag.FALSE`
 * (default-closed). Read as text, so corruption never throws.
 */
export async function readNewBookDefault(
  kv: KVNamespace,
  userId: string,
): Promise<BoolFlag | null> {
  const raw = await kv.get(kvKeys.newBookDefault(userId));
  return raw === null ? null : parseStoredFlag(raw);
}

/**
 * Write `newbookdefault:{userId}` as `{ newBookDefaultShared }`. No TTL — a
 * personal setting that survives family changes (security-ux Invariant 5).
 * Caller: `PUT /api/user/:id/new-book-default` only.
 */
export async function putNewBookDefault(
  kv: KVNamespace,
  userId: string,
  flag: BoolFlag,
): Promise<void> {
  const record: NewBookDefaultRecord = { newBookDefaultShared: flag };
  await kv.put(kvKeys.newBookDefault(userId), JSON.stringify(record));
}

/** Delete `newbookdefault:{userId}` — whole-account teardown only. */
export async function deleteNewBookDefault(
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  await kv.delete(kvKeys.newBookDefault(userId));
}
