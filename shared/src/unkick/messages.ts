/**
 * Copy for removing a family member: the owner's remove confirmation, the
 * "lift the rejoin block" (un-kick) notice shown after the removal, and the
 * removed member's refused join.
 *
 * 產品語意：解除的是後端的 kicked tombstone（6 小時內擋住同步碼重新加入），
 * **不會**把對方加回家庭（Inv-4）——對方仍須自己輸入同步碼。文案必須維持這個區別。
 *
 * Shared by the Extension and PWA so the wording stays identical on both sides
 * (the notice renders from two separate components). Pure functions and
 * constants, no side effects.
 */

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
 * 剛移除成員、限制尚未解除時顯示的文案。Only the pre-un-kick state renders it,
 * so the "closing or leaving ends the chance" warning never shows once the block is lifted.
 */
export function buildRemovedNoticeText(displayName: string): string {
  return `已移除 ${displayName}，對方 ${REJOIN_BLOCK_HOURS} 小時內無法用同步碼重新加入。如果是誤移除，可以在這裡解除限制；關閉這則通知或離開這個畫面後，就無法再解除。`;
}

/**
 * 解除限制成功後顯示的文案。
 *
 * 括號內的傳播延遲不是保守說法：tombstone 刪除後，仍持有舊 key 的 colo 最長約
 * 一分鐘才會看到，期間對方重新加入可能仍被拒（重試即可）。
 */
export function buildUnkickedNoticeText(displayName: string): string {
  return `已解除限制，${displayName} 可重新使用同步碼加入（可能需要約一分鐘生效）`;
}

/** 通知卡固定顯示的提醒：解除限制不等於把成員加回家庭。 */
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
