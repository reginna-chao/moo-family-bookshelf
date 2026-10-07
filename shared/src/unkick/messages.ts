/** Member-removal copy (remove confirm, un-kick notice, refused rejoin), shared so both apps match. Un-kick
 *  lifts the rejoin block only, never re-adds the member — see docs/architecture.md → 共用文案的產品語意. */

/**
 * How long a removed member is refused a rejoin. The client-side source of the
 * number every string below shows; it must equal the Worker's
 * `KICKED_TOMBSTONE_TTL_SECONDS / 3600` (`worker/src/kv/schema.ts`), which a
 * Worker test pins.
 */
export const REJOIN_BLOCK_HOURS = 6;

/** Appended to the owner's "remove this member?" confirmation question. */
export const REJOIN_WAIT_NOTE = `移除後，對方 ${REJOIN_BLOCK_HOURS} 小時內無法用同步碼重新加入。`;

/**
 * Notice shown right after a removal, while the rejoin block is still in place. Only that state
 * renders it, so the "closing or leaving ends the chance" warning never shows once the block is lifted.
 */
export function buildRemovedNoticeText(displayName: string): string {
  return `已移除 ${displayName}，對方 ${REJOIN_BLOCK_HOURS} 小時內無法用同步碼重新加入。如果是誤移除，可以在這裡解除限制；關閉這則通知或離開這個畫面後，就無法再解除。`;
}

/**
 * Notice shown once the block is lifted. The bracketed delay is real, not hedging: after the tombstone
 * is deleted, a colo still holding the old key can take up to about a minute to see it, and a rejoin in
 * that window may still be refused (a retry succeeds).
 */
export function buildUnkickedNoticeText(displayName: string): string {
  return `已解除限制，${displayName} 可重新使用同步碼加入（可能需要約一分鐘生效）`;
}

/** Fixed reminder on the notice card: lifting the block does not add the member back to the family. */
export const UNKICK_HINT_TEXT =
  "解除後對方仍需自行輸入同步碼加入，不會自動回到家庭。";

/**
 * What a removed member sees when a join is refused with `MEMBER_REMOVED`.
 * Manual-join paths show it as is; the recovery paths append their own
 * logout / unbind sentence.
 */
export const REMOVED_JOIN_TEXT = `你已被家庭管理者移出這個家庭，移除後 ${REJOIN_BLOCK_HOURS} 小時內無法重新加入。`;

/**
 * `REMOVED_JOIN_TEXT` when `errorCode` is `MEMBER_REMOVED`, otherwise
 * `undefined` — lets a caller fall back to its generic copy with `??`.
 */
export function removedJoinText(errorCode: string): string | undefined {
  return errorCode === "MEMBER_REMOVED" ? REMOVED_JOIN_TEXT : undefined;
}
