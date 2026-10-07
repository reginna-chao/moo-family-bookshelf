/** Family dissolve (sole-member owner or last listed member leaving / deleting their account), shared by
 *  routes/family.ts and routes/user.ts; HTTP-agnostic. Layering: .claude/rules/backend.md → Project Structure. */
import { deleteFamilyRecord } from "../kv/families";
import { deleteBorrowIndex } from "./borrowIndex";

/**
 * Delete a family's storage: the borrow index, then `family:{familyId}`. Every
 * caller is a path that would otherwise leave the family with nobody in it —
 * a sole-member owner leaving or deleting their account, or the last listed
 * member doing either (a removal never writes an empty member list, because
 * `normalizeFamilyRecord` throws on `members: []` and the family would answer
 * 500 on every later read). Pointer and token cleanup stay with the caller,
 * which runs them AFTER this returns: a failure after the family delete leaves
 * only an orphan pointer, which create cleans up and join treats as no
 * membership.
 *
 * The index is dropped FAIL-OPEN and BEFORE the family record, deliberately: it
 * is cleanup, not part of the dissolve's meaning, so it must never keep a
 * member in a family they asked to leave (or block the account deletion they
 * asked for) — a caught throw is logged and the dissolve proceeds, so the order
 * helps only when the request is cut short before the family delete: the family
 * key is still there, so the dissolve can be retried. Without it the index
 * outlives the family as a permanent orphan — the reclaim gap the departure
 * purge closes on the other side.
 *
 * Side effects: the borrow-index deletes (see `deleteBorrowIndex`; a throw is
 * logged as `BORROW_INDEX_DELETE_FAILED` and swallowed), then one KV delete. A
 * throw from the family delete propagates.
 */
export async function dissolveFamily(
  kv: KVNamespace,
  familyId: string,
): Promise<void> {
  try {
    await deleteBorrowIndex(kv, familyId);
  } catch (err) {
    console.error("BORROW_INDEX_DELETE_FAILED", { familyId, err });
  }
  await deleteFamilyRecord(kv, familyId);
}
