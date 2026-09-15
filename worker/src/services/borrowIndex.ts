/**
 * The family borrow index — read, trim and write helpers shared by the
 * `borrow` and `family` route modules. It lives here rather than in
 * `routes/borrow.ts` because a route module must never import business logic
 * from a SIBLING route module (lint-enforced); logic needed by two or more
 * routes belongs in `services/`.
 *
 * Unlike `services/verification.ts`, this module is HTTP-agnostic: it takes a
 * `KVNamespace` and returns plain data, so the handlers keep every status code
 * and error envelope decision.
 *
 * SHAPE. `borrows:family:{familyId}` holds the full `BorrowRequest[]` and is
 * the SINGLE SOURCE OF TRUTH for a family's borrow requests.
 * `borrow:{requestId}` is only a `BorrowPointer` (`{ familyId }`), whose one
 * job is to let `PATCH /api/borrow/:requestId` find the owning family from a
 * bare requestId. Previously the records lived under `borrow:{requestId}` and
 * the index held only ids, so listing (and the create handler's duplicate
 * check) fanned out one KV read per historical entry — O(index) reads on a hot
 * path.
 *
 * LEGACY DATA, and why it is never rewritten. A pre-migration index is a
 * `string[]` of requestIds; a pre-migration `borrow:{requestId}` is a FULL
 * `BorrowRequest`. Both are readable here: `readBorrowIndex` fans a `string[]`
 * index out ONE last time, and `readBorrowPointer` reads `.familyId` — a field
 * BOTH shapes carry — and nothing else. After the family's next write the
 * index carries the records, so the legacy `borrow:{id}` VALUE becomes a stale
 * copy that no reader ever consults; only its existence still matters, as the
 * pointer. Rewriting it would cost a KV write per record for data nobody
 * reads.
 *
 * MIGRATION IS LAZY AND WRITE-PATH ONLY: create, `PATCH`, and the departure
 * settlement (`settleDepartingBorrower`, called from member removal in
 * `routes/family.ts` and from account deletion in `routes/user.ts`) rewrite
 * the index in the new shape. `GET /api/family/:id/borrow` serves BOTH shapes
 * and performs no KV write at all. `deleteBorrowIndex` is the one write path
 * that never migrates: it removes the key outright, and reads the stored value
 * only to learn which pointers to delete alongside it.
 *
 * NO CAS. Every write below is a read-modify-write of one key and KV has no
 * compare-and-set, so two concurrent writers on the SAME family can lose one
 * another's update (last put wins). Accepted residual — see
 * `docs/architecture.md` → 已接受的殘餘風險.
 */
import {
  kvKeys,
  BORROW_HISTORY_KEEP,
  BorrowStatus,
  TERMINAL_BORROW_STATUSES,
  type BorrowPointer,
  type BorrowRequest,
} from "../kv/schema";
import { isValidFamilyId } from "../utils/validation";

/** A family's borrow requests, plus where they were read from. */
export interface BorrowIndexRead {
  /** Every live request, in index order. Empty when the family has none. */
  requests: BorrowRequest[];
  /**
   * `true` when the stored index was still the legacy `string[]` and the
   * records had to be fanned out. Diagnostic only: every write path rewrites
   * the new shape regardless, so no caller branches on it.
   */
  legacy: boolean;
}

/** What a trim kept and what it evicted. */
export interface BorrowIndexTrim {
  /** Survivors, in the input's relative order. */
  kept: BorrowRequest[];
  /** Evicted terminal records — their `borrow:{id}` keys are deleted. */
  dropped: BorrowRequest[];
}

/** What a departure settlement changed. Counts only, for logging and tests. */
export interface BorrowDepartureSettlement {
  /** PENDING requests flipped to CANCELLED because the member is leaving. */
  cancelled: number;
  /** Terminal records removed from the index because the member borrowed them. */
  evicted: number;
}

/**
 * A stored index is legacy when it is an array of requestId STRINGS. The new
 * shape is an array of objects, so the first element decides it.
 *
 * An EMPTY array is deliberately not legacy: both shapes serialize the empty
 * family identically, and treating it as new-shape avoids a pointless fan-out
 * over nothing.
 */
export function isLegacyBorrowIndex(value: unknown): value is string[] {
  return Array.isArray(value) && typeof value[0] === "string";
}

/**
 * Read a family's borrow requests. PURE READ — never migrates, never writes,
 * so `GET /api/family/:id/borrow` can call it safely.
 *
 * Absent / `null` / any non-array value ⇒ no requests. The `Array.isArray`
 * check is the "validate at system boundaries" guard for a `kv.get(…, "json")`
 * cast that nothing validates: a corrupted container degrades to an empty list
 * instead of throwing a TypeError into a 500. Element fields stay unvalidated
 * (the records were written by this Worker).
 */
export async function readBorrowIndex(
  kv: KVNamespace,
  familyId: string,
): Promise<BorrowIndexRead> {
  const stored = await kv.get<BorrowRequest[] | string[]>(
    kvKeys.borrowsByFamily(familyId),
    "json",
  );

  if (!Array.isArray(stored) || stored.length === 0) {
    return { requests: [], legacy: false };
  }

  if (isLegacyBorrowIndex(stored)) {
    // The legacy fan-out, performed one last time. Missing records are dropped
    // (defensive: the old index could outlive a record it named).
    const records = await Promise.all(
      stored.map((id) => kv.get<BorrowRequest>(kvKeys.borrow(id), "json")),
    );
    return {
      requests: records.filter((r): r is BorrowRequest => r !== null),
      legacy: true,
    };
  }

  return { requests: stored, legacy: false };
}

/**
 * Newest first: `updatedAt`, then `createdAt`. Both are ISO-8601 UTC strings
 * produced by `toISOString()`, so lexical order IS chronological order.
 * Returning 0 on a full tie leaves the sort stable, which is what preserves
 * the index's own order as the final tie-break.
 */
function compareByRecency(a: BorrowRequest, b: BorrowRequest): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return 0;
}

/**
 * Cap the index: keep EVERY active request (PENDING / LENT), and of the
 * TERMINAL ones (RETURNED / REJECTED / CANCELLED) keep the newest
 * `BORROW_HISTORY_KEEP` PER `borrowerId`.
 *
 * PER BORROWER, not per family. A family-wide cap makes one member's finished
 * borrows evict another member's history — an eviction lever aimed at somebody
 * else's records on a shared value. Grouped by borrower, a member can only ever
 * push out their OWN oldest entries, and the family-level bound becomes
 * (members × `BORROW_HISTORY_KEEP`) terminal records plus every live one.
 *
 * PURE — the KV side effects of an eviction live in `writeBorrowIndex`. Active
 * requests are never evicted at any count: they are the ones a member can
 * still act on, and silently dropping one would strand a lent book. That is
 * structural here, not a condition to re-check — only terminal records are ever
 * grouped, so only a terminal record can end up in `dropped`. The PENDING half
 * of "active" is instead bounded at the create boundary, by
 * `BORROW_MAX_PENDING_PER_BORROWER`; LENT stays uncapped, since each one
 * required the owner's explicit approval.
 *
 * `kept` preserves the caller's relative order, so the index does not reshuffle
 * on every write and clients keep a stable list.
 */
export function trimBorrowIndex(requests: BorrowRequest[]): BorrowIndexTrim {
  const terminalByBorrower = new Map<string, BorrowRequest[]>();
  for (const request of requests) {
    if (!TERMINAL_BORROW_STATUSES.has(request.status)) continue;
    const group = terminalByBorrower.get(request.borrowerId);
    if (group === undefined) {
      terminalByBorrower.set(request.borrowerId, [request]);
    } else {
      group.push(request);
    }
  }

  // Collect what is EVICTED rather than what survives: a borrower under the cap
  // contributes nothing, so no group has to be enumerated (or sorted) just to
  // be kept. `group` is a local array, so sorting it does not reorder `kept`.
  const evictedIds = new Set<string>();
  for (const group of terminalByBorrower.values()) {
    if (group.length <= BORROW_HISTORY_KEEP) continue;
    for (const request of group
      .sort(compareByRecency)
      .slice(BORROW_HISTORY_KEEP)) {
      evictedIds.add(request.requestId);
    }
  }

  if (evictedIds.size === 0) {
    return { kept: requests, dropped: [] };
  }

  const kept: BorrowRequest[] = [];
  const dropped: BorrowRequest[] = [];
  for (const request of requests) {
    if (evictedIds.has(request.requestId)) {
      dropped.push(request);
    } else {
      kept.push(request);
    }
  }
  return { kept, dropped };
}

/**
 * Delete the `borrow:{requestId}` pointers of records that just left the index,
 * FAIL-OPEN — the single site for that cleanup, shared by the trim eviction,
 * the departure settlement and the whole-index delete.
 *
 * Fail-open follows `writeKickedTombstone` in `routes/family.ts`: each delete
 * swallows its own rejection into a `console.error`. Every caller runs this
 * AFTER the index write that removed the records has already landed, so a
 * failed delete costs exactly one orphan key — invisible to every reader, and
 * a PATCH naming it gets the same `404 REQUEST_NOT_FOUND` an unknown id gets.
 * Letting it reject would instead turn a persisted, successful write into a
 * 500 and tell the caller their operation failed when it did not.
 */
async function deleteBorrowPointers(
  kv: KVNamespace,
  requestIds: string[],
): Promise<void> {
  if (requestIds.length === 0) return;

  await Promise.all(
    requestIds.map((requestId) =>
      kv.delete(kvKeys.borrow(requestId)).catch((err: unknown) => {
        console.error("BORROW_POINTER_DELETE_FAILED", { requestId, err });
      }),
    ),
  );
}

/**
 * Trim, then persist the index, then delete the evicted records' pointers.
 * This is the ONLY writer of `borrows:family:{familyId}` and the write that
 * migrates a legacy family to the new shape.
 *
 * Write order is deliberate, and it follows the SAME rule the create handler
 * does: never leave an index entry whose pointer is missing — prefer an orphan
 * pointer. Here that means the index put comes BEFORE the evicted pointers'
 * deletes, since deleting first would strip the pointer off a record still in
 * the index and no PATCH could then resolve its family. In `routes/borrow.ts`
 * create, the same rule puts the POINTER before the index write. Both land on
 * the harmless side: an orphan pointer no reader can see, rather than an index
 * entry both parties see and nobody can act on.
 *
 * The eviction deletes go through `deleteBorrowPointers` (FAIL-OPEN — see its
 * JSDoc). They are the ONLY KV cost the trim adds, and they happen solely on
 * the writes that actually exceed the cap.
 *
 * NOTE for callers that removed records from `requests` themselves: this
 * deletes the pointers of the records ITS OWN trim dropped, and of nothing
 * else. A caller that filtered records out before calling must delete those
 * pointers itself — `settleDepartingBorrower` below is the one such caller.
 */
export async function writeBorrowIndex(
  kv: KVNamespace,
  familyId: string,
  requests: BorrowRequest[],
): Promise<{ dropped: BorrowRequest[] }> {
  const { kept, dropped } = trimBorrowIndex(requests);

  await kv.put(kvKeys.borrowsByFamily(familyId), JSON.stringify(kept));

  await deleteBorrowPointers(
    kv,
    dropped.map((r) => r.requestId),
  );

  return { dropped };
}

/**
 * Settle a member's borrow records as they leave the family, in two steps:
 *
 * 1. CANCEL every PENDING request the departing member is either side of
 *    (`borrowerId` or `ownerId`). LENT is untouched — the book may still be
 *    physically out on loan and the counterparty must be able to close it.
 * 2. PURGE from the index every TERMINAL record (RETURNED / REJECTED /
 *    CANCELLED, including the ones just cancelled) whose `borrowerId` is the
 *    departing member, and delete those records' pointers.
 *
 * Records where the departing member is the OWNER are KEPT: they belong to the
 * remaining member's own history, and the trim groups terminal records by
 * `borrowerId`, so they keep counting against THAT borrower's
 * `BORROW_HISTORY_KEEP` allowance and remain evictable by their own newer
 * borrows. Purging by `ownerId` too would let a leaver delete a family
 * member's records.
 *
 * WHY the purge exists (security finding F-1). `BORROW_HISTORY_KEEP` is capped
 * per `borrowerId`, and a borrowerId is free to mint: anyone holding the sync
 * code can join with a fresh userId, open up to
 * `BORROW_MAX_PENDING_PER_BORROWER` requests, leave — which turned every one of
 * them into a CANCELLED record under a borrowerId that would never write again,
 * so its group could never be trimmed — and repeat. The index is ONE KV value
 * with a 25 MiB ceiling, so that loop grew it without any reclaim path until
 * create / PATCH / member removal all failed. Making departure remove the
 * leaver's own terminal records means the loop leaves nothing permanent behind.
 *
 * TRIPWIRE. "Nothing permanent" covers TERMINAL records only — step 1 cancels
 * PENDING, step 2 purges terminal ones — so a LENT record whose borrower left
 * is neither settled here nor evictable by `trimBorrowIndex`, and would be F-1
 * in another form. Two preconditions OUTSIDE this file keep that state
 * unreachable: (a) PENDING → LENT needs the BOOK OWNER's approval
 * (`validateStatusTransition` in `routes/borrow.ts` demands `isOwner`), and
 * create refuses both a self-borrow (`403 INVALID_OWNER_SELF`) and an `ownerId`
 * that is not a family member (`403 INVALID_OWNER`), so borrower and owner are
 * always two DIFFERENT members of the family; (b) `maxMembers` is 2 —
 * hard-coded at family create in `routes/family.ts`, enforced by its join
 * capacity check, defaulted in `kv/schema.ts` — so a sync-code holder cannot
 * hold BOTH seats of someone else's family with minted ids and approve their
 * own requests. Relax either one (a configurable or larger `maxMembers`, an
 * approval path needing no second member) and two minted ids can approve each
 * other into LENT, leave, and those records stay forever. Revisit
 * `settleDepartingBorrower` first — settle LENT too, or purge by `ownerId` as
 * well — before relaxing them.
 *
 * Writes NOTHING when neither step changed anything — a family with no records
 * of the departing member stays exactly as it was, legacy shape included.
 *
 * Order is the module's standing rule: the index put lands first
 * (`writeBorrowIndex`), the pointer deletes after, so no index entry is ever
 * left without its pointer.
 */
export async function settleDepartingBorrower(
  kv: KVNamespace,
  familyId: string,
  userId: string,
): Promise<BorrowDepartureSettlement> {
  const { requests } = await readBorrowIndex(kv, familyId);
  if (requests.length === 0) return { cancelled: 0, evicted: 0 };

  const now = new Date().toISOString();
  let cancelled = 0;

  for (const request of requests) {
    if (request.status !== BorrowStatus.PENDING) continue;
    if (request.borrowerId !== userId && request.ownerId !== userId) continue;

    request.status = BorrowStatus.CANCELLED;
    request.updatedAt = now;
    cancelled += 1;
  }

  const kept: BorrowRequest[] = [];
  const evicted: string[] = [];
  for (const request of requests) {
    const isOwnHistory =
      request.borrowerId === userId &&
      TERMINAL_BORROW_STATUSES.has(request.status);
    if (isOwnHistory) {
      evicted.push(request.requestId);
    } else {
      kept.push(request);
    }
  }

  if (cancelled === 0 && evicted.length === 0) {
    return { cancelled: 0, evicted: 0 };
  }

  await writeBorrowIndex(kv, familyId, kept);
  // `writeBorrowIndex` only deletes what ITS trim dropped; the departure
  // evictions never reach the trim, so their pointers are deleted here.
  await deleteBorrowPointers(kv, evicted);

  return { cancelled, evicted: evicted.length };
}

/**
 * Delete a family's whole borrow index and every pointer it names — the
 * dissolve path (sole-owner leave, sole-member account deletion), where the
 * family key itself is going away and the index would otherwise become an
 * orphan no write path ever visits again.
 *
 * Reads the stored value ONLY to enumerate requestIds, so it deliberately does
 * not go through `readBorrowIndex`: a legacy `string[]` index already IS the
 * id list, and fanning it out into records would spend one KV read each to
 * learn ids we already hold.
 *
 * Pointer deletes come FIRST here, and that inverts the module's usual order on
 * purpose: the "never leave an index entry without its pointer" rule protects
 * readers of a LIVE index, and this call is removing the index outright. A
 * failure part-way therefore leaves at worst orphan pointers plus an index no
 * family record points at — the same state a pre-existing dissolve left behind.
 * The pointer deletes stay fail-open for the same reason they are elsewhere.
 *
 * No-op when the index key is absent.
 */
export async function deleteBorrowIndex(
  kv: KVNamespace,
  familyId: string,
): Promise<void> {
  const stored = await kv.get(kvKeys.borrowsByFamily(familyId), "json");

  if (stored === null) return;

  await deleteBorrowPointers(kv, enumerateRequestIds(stored));
  await kv.delete(kvKeys.borrowsByFamily(familyId));
}

/**
 * The requestIds a stored index names, in EITHER shape.
 *
 * Takes `unknown` because a `kv.get(…, "json")` value is unvalidated: a
 * corrupted container yields no ids instead of throwing, and its key is deleted
 * anyway — the family that owned it is being dissolved.
 */
function enumerateRequestIds(stored: unknown): string[] {
  if (isLegacyBorrowIndex(stored)) return stored;
  if (!Array.isArray(stored)) return [];

  const records: BorrowRequest[] = stored;
  return records.map((request) => request.requestId);
}

/**
 * Resolve `borrow:{requestId}` to the familyId whose index owns the record.
 *
 * Reads BOTH shapes: a new-shape `BorrowPointer` and a legacy full
 * `BorrowRequest` both carry `familyId`, and nothing else on the legacy record
 * is read — the index is the truth for status and fields. Returns `null` for
 * an absent key or any value whose `familyId` is not a WELL-FORMED familyId,
 * which the caller turns into `404 REQUEST_NOT_FOUND`.
 *
 * The format check (not just "non-empty string") is defence in depth: this
 * value is interpolated straight into the `borrows:family:{familyId}` key the
 * PATCH handler then reads AND rewrites, so a corrupted pointer must not be
 * able to aim that read-modify-write at an arbitrary key. Today only this
 * Worker writes pointers, so a rejection means corruption, not an attack.
 */
export async function readBorrowPointer(
  kv: KVNamespace,
  requestId: string,
): Promise<string | null> {
  // `Partial<>` because this is an unvalidated KV JSON cast: the field must be
  // checked, not assumed.
  const stored = await kv.get<Partial<BorrowPointer>>(
    kvKeys.borrow(requestId),
    "json",
  );
  const familyId = stored?.familyId;
  if (typeof familyId !== "string" || !isValidFamilyId(familyId)) return null;
  return familyId;
}

/**
 * Write the `borrow:{requestId}` pointer — the create handler's first write.
 *
 * The only `put` on that key: every other site either reads it
 * (`readBorrowPointer`) or deletes it (`deleteBorrowPointers`), and legacy full
 * `BorrowRequest` values are deliberately never rewritten. Keeping the pointer
 * SHAPE here means the create handler cannot accidentally store a different one.
 *
 * Persistent (no TTL) — the record's lifetime is bounded by the index trim and
 * the departure purge, which delete the pointer along with the record.
 *
 * Call ORDER is the caller's responsibility and is load-bearing: create writes
 * this pointer BEFORE `writeBorrowIndex`, so a half-failure leaves an invisible
 * orphan pointer rather than a PENDING ghost nobody can act on.
 */
export async function writeBorrowPointer(
  kv: KVNamespace,
  requestId: string,
  familyId: string,
): Promise<void> {
  const pointer: BorrowPointer = { familyId };
  await kv.put(kvKeys.borrow(requestId), JSON.stringify(pointer));
}
