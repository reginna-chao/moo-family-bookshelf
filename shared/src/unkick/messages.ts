/**
 * Copy for the "lift the rejoin block" (un-kick) notice shown after an owner
 * removes a family member.
 *
 * 產品語意：解除的是後端的 kicked tombstone（6 小時內擋住同步碼重新加入），
 * **不會**把對方加回家庭（Inv-4）——對方仍須自己輸入同步碼。文案必須維持這個區別。
 *
 * Shared by the Extension and PWA so the wording stays identical on both sides
 * (the notice renders from two separate components). Pure functions and
 * constants, no side effects.
 */

/** 剛移除成員、限制尚未解除時顯示的文案。 */
export function buildRemovedNoticeText(displayName: string): string {
  return `已移除 ${displayName}。若為誤移除，可解除限制讓對方重新加入。`;
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
