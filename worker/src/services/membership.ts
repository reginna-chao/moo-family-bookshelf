/** Membership rules, HTTP-agnostic: live (pointer-first; family create / join, auth lookup) and active (#222,
 *  list-first; bookshelf / borrow / family). See .claude/rules/backend.md → API Design (listed AND pointed). */
import {
  type FamilyMember,
  hasMember,
  normalizeFamilyRecord,
} from "../kv/schema";
import { getFamilyRecord, getMemberFamilyId } from "../kv/families";

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

/**
 * Active-member rule for family-scoped authorization: `userId` is an ACTIVE
 * member of `familyId` only when the family record LISTS the user AND the
 * user's `member:{userId}` pointer names this same family. It is the same
 * two-sided rule {@link readLiveMembers} applies, entered from the other side —
 * that one starts from a pointer and confirms the list, this one starts from a
 * list the handler already read and confirms the pointer.
 *
 * WHY (#222): `family:{id}` is a read-modify-write with no CAS. A full-record
 * write that read the member list before an owner's kick (a reconnect's
 * displayName write-back, the displayName / member-settings endpoints) can land
 * after the kick's list put and RE-LIST the kicked member, whose pointer the
 * kick has already deleted. KV cannot stop that write, so the list alone is not
 * proof of membership: such a "hollow" member (listed, pointerless, possibly
 * holding a fresh token) is made inert instead — every member-level
 * family-scoped check (bookshelf aggregation, borrow create / list / PATCH,
 * displayName, member-settings, the transfer target) asks this rule, not
 * `hasMember`. So do the owner-only checks in `routes/family.ts` (remove-member
 * incl. the sole-owner dissolve, un-kick, transfer): the caller is the owner
 * only when `callerId === record.ownerId` AND this rule holds, because the same
 * stale write can restore `ownerId` to a kicked ex-owner. The endpoint PUT
 * applies the same rule inline: it reads the caller's pointer first, then —
 * with the record in hand — requires the caller to be listed (`hasMember`), so
 * it pays no second pointer read. One owner check is deliberately NOT routed
 * here: the remove-member refusal `OWNER_CANNOT_LEAVE` (the recorded, listed
 * owner leaving while others are listed) goes by `ownerId` + the list alone,
 * so a missed pointer read can never let an owner leave a family behind with
 * no listed owner.
 *
 * Deliberately NOT applied to `GET /api/family/:id/members`: it keeps listing
 * hollow members, because the owner must see one to re-kick it — a hidden
 * hollow member would still occupy a `maxMembers` slot and make joins answer
 * FAMILY_FULL with nobody visible to remove. (That GET still requires the
 * CALLER to be active.)
 *
 * Side effect: at most one KV read — none when the user is not listed, one
 * pointer read otherwise.
 */
export async function isActiveMember(
  kv: KVNamespace,
  familyId: string,
  userId: string,
  members: FamilyMember[],
): Promise<boolean> {
  if (!hasMember(members, userId)) return false;
  return (await getMemberFamilyId(kv, userId)) === familyId;
}

/**
 * Narrow an already-read member list to its ACTIVE members (see
 * {@link isActiveMember}), preserving list order. Used by the family bookshelf
 * aggregation so a hollow member's shared books never reach the others.
 *
 * `verifiedUserId` names a member whose pointer the caller has ALREADY
 * confirmed to name `familyId` in this request (the authenticated caller); that
 * member is kept without a second read of the same key.
 *
 * Side effect: one KV read per listed member other than `verifiedUserId`, all
 * issued in PARALLEL.
 */
export async function filterActiveMembers(
  kv: KVNamespace,
  familyId: string,
  members: FamilyMember[],
  verifiedUserId?: string,
): Promise<FamilyMember[]> {
  const verdicts = await Promise.all(
    members.map(async (member) =>
      member.userId === verifiedUserId
        ? true
        : (await getMemberFamilyId(kv, member.userId)) === familyId,
    ),
  );
  return members.filter((_, index) => verdicts[index]);
}
