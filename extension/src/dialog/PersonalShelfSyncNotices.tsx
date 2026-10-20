import { AUTO_SHARE_MAX_NEW } from "../sync/autoShare";
import type { SyncNoticeCounts } from "./lastSync";

/** Notice shown after a sync moved books to their new Readmoo id (#236). */
export function renamedBooksNotice(count: number): string {
  return `讀墨更換了 ${count} 本書的編號，書櫃已改用新編號，分享設定維持原本的選擇`;
}

/** Notice shown after a sync removed books Readmoo no longer holds (#241). */
export function removedBooksNotice(count: number, sharedCount: number): string {
  const base = `已移除 ${count} 本讀墨書櫃裡已經沒有的書`;
  return sharedCount > 0 ? `${base}，其中 ${sharedCount} 本原本設為分享` : base;
}

/** Notice shown after a sync marked books new to the server as shared (新書預設開放, #238). */
export function autoSharedBooksNotice(count: number): string {
  return `已自動開放 ${count} 本新加入個人書櫃的書給家人，也會出現在你的公開書櫃`;
}

/** Notice shown when 新書預設開放 left a sync's new books unshared because there were too many. */
export function autoShareHeldNotice(count: number): string {
  return `這次新增了 ${count} 本書，一次超過 ${AUTO_SHARE_MAX_NEW} 本不會自動開放，請自己選要開放哪些`;
}

/** Notice shown when a sync left out new books whose title is over the server's cap (#326, `sync/fieldCaps.ts`). */
export function overLongBooksNotice(count: number): string {
  return `有 ${count} 本書的書名太長，伺服器存不下，沒有加進個人書櫃`;
}

/** Notice shown when a sync uploaded new books with an over-cap author or category left blank (#326). */
export function blankedFieldsNotice(count: number): string {
  return `有 ${count} 本書的作者或分類太長，伺服器存不下，書還是加進了個人書櫃，只是不顯示太長的那一欄`;
}

export interface PersonalShelfSyncNoticesProps {
  /** Live scrape progress; empty when no scrape is running. */
  progressMessage: string;
  /** Sync error to show; empty when the last sync did not fail. */
  syncError: string;
  /** Renamed / removed / auto-shared / left-out / blanked book counts of the last successful sync. */
  counts: SyncNoticeCounts;
}

/** Sync status lines under the personal-shelf header. */
export function PersonalShelfSyncNotices({
  progressMessage,
  syncError,
  counts,
}: PersonalShelfSyncNoticesProps) {
  return (
    <>
      {progressMessage && (
        <div className="moo-shelf__progress">{progressMessage}</div>
      )}
      {syncError && <p className="moo-shelf__sync-error">{syncError}</p>}
      {counts.renamedBookCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {renamedBooksNotice(counts.renamedBookCount)}
        </p>
      )}
      {counts.removedBookCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {removedBooksNotice(
            counts.removedBookCount,
            counts.removedSharedCount,
          )}
        </p>
      )}
      {counts.autoSharedCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {autoSharedBooksNotice(counts.autoSharedCount)}
        </p>
      )}
      {counts.autoShareHeldCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {autoShareHeldNotice(counts.autoShareHeldCount)}
        </p>
      )}
      {counts.fieldCapSkippedCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {overLongBooksNotice(counts.fieldCapSkippedCount)}
        </p>
      )}
      {counts.fieldCapBlankedCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {blankedFieldsNotice(counts.fieldCapBlankedCount)}
        </p>
      )}
    </>
  );
}
