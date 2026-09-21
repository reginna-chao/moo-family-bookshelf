/**
 * The per-borrower finished-borrow history cap, plus the two UI hints that
 * state it to the user.
 *
 * The Worker enforces the cap when it rewrites a family's borrow index, and
 * the Extension / PWA borrow tabs tell the user what the cap is. Those two
 * must be the same number — a hint promising more records than the trim keeps
 * would point at history that is already gone — so the constant lives here and
 * `worker/src/kv/schema.ts` re-exports it, leaving every Worker-side importer
 * on its existing path.
 *
 * Pure constants, runtime-agnostic: no globals, no side effects.
 */

/**
 * How many TERMINAL borrow records (RETURNED / REJECTED / CANCELLED) a
 * family's borrow index (`borrows:family:{familyId}`) keeps PER `borrowerId`,
 * newest first by `updatedAt`.
 *
 * PENDING and LENT records are never trimmed at any count — they are still
 * actionable, and evicting one would strand a lent book.
 *
 * Enforced by `trimBorrowIndex` in `worker/src/services/borrowIndex.ts` on
 * every index write; displayed by the borrow UIs through
 * {@link BORROW_HISTORY_HINT_OUTGOING} / {@link BORROW_HISTORY_HINT_INCOMING}.
 */
export const BORROW_HISTORY_KEEP = 50;

/**
 * Hint shown under the expanded 歷史紀錄 list of the 寄件匣 (the caller's own
 * borrow requests).
 *
 * The cap is keyed per BORROWER, and every request in this box has the caller
 * as its borrower, so the whole box is bounded by
 * {@link BORROW_HISTORY_KEEP} — which is why this sentence differs from
 * {@link BORROW_HISTORY_HINT_INCOMING}.
 */
export const BORROW_HISTORY_HINT_OUTGOING = `已完成的紀錄最多保留最近 ${BORROW_HISTORY_KEEP} 筆，更早的會自動清除`;

/**
 * Hint shown under the expanded 歷史紀錄 list of the 收件匣 (requests other
 * family members made for the caller's books).
 *
 * The cap is keyed per BORROWER, and this box mixes several borrowers, so it
 * holds up to {@link BORROW_HISTORY_KEEP} records for EACH family member who
 * requested a book — no single member's history can push out another's.
 */
export const BORROW_HISTORY_HINT_INCOMING = `每位家人的已完成紀錄各保留最近 ${BORROW_HISTORY_KEEP} 筆`;
