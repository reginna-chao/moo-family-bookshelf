/**
 * Family dissolve — deletes a family's storage. Shared by `routes/family.ts`
 * (member removal: the sole-member owner leaving, and the last listed member
 * leaving) and `routes/user.ts` (account deletion: the sole-member owner, and
 * the last listed member). It lives here because a route module must never
 * import logic from a SIBLING route module (lint-enforced); logic needed by two
 * or more routes belongs in `services/`.
 *
 * Like `services/borrowIndex.ts` this module is HTTP-agnostic: it takes a
 * `KVNamespace` and returns nothing, so the handlers keep every status code and
 * response-shape decision.
 */
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
