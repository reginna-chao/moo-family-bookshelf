/**
 * Live-membership rule — shared by `routes/family.ts` (create's
 * `classifyMembershipForCreate` and join's pre-gate ALREADY_IN_FAMILY check)
 * and `routes/auth.ts` (`POST /api/auth/lookup`). It lives here because a
 * route module must never import logic from a SIBLING route module
 * (lint-enforced); logic needed by two or more routes belongs in `services/`.
 *
 * Like `services/borrowIndex.ts` this module is HTTP-agnostic: it takes a
 * `KVNamespace` and returns plain data, so the handlers keep every status code
 * and response-shape decision.
 */
import {
  type FamilyMember,
  hasMember,
  normalizeFamilyRecord,
} from "../kv/schema";
import { getFamilyRecord } from "../kv/families";

/**
 * Resolve a `member:{userId}` pointer naming `familyId` to live membership:
 * the family record exists AND lists the user. Returns that family's members,
 * or `null` when the pointer is stale.
 *
 * WHY (#213): a pointer can outlive its membership — an ORPHAN, left when a
 * create (pointer put, then family put) or a sole-owner dissolve (family
 * delete, then pointer delete) fails between its two writes, or a pointer at a
 * family that no longer lists the user (a join racing a kick, a stale read at
 * the removal). Such a pointer must neither block create / join with
 * ALREADY_IN_FAMILY nor make lookup report a family the user is not in.
 *
 * Accepted edge: a cross-colo stale read of the family record (within ~60s of
 * the user's OWN join landing) can classify a genuine membership as stale, and
 * the create / join that follows would then leave the user listed in the old
 * record too, with the pointer moved to the new family. The clients never offer
 * create / join while the user is in a family, so this is not reachable
 * through the UI.
 *
 * Side effect: exactly one KV read (the family record).
 */
export async function readLiveMembers(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<FamilyMember[] | null> {
  const raw = await getFamilyRecord(kv, familyId);
  if (!raw) return null;
  const { members } = normalizeFamilyRecord(raw);
  return hasMember(members, userId) ? members : null;
}

/**
 * Boolean form of {@link readLiveMembers} for callers that need only the
 * verdict. Exactly one KV read.
 */
export async function isLiveMembership(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<boolean> {
  return (await readLiveMembers(kv, familyId, userId)) !== null;
}
