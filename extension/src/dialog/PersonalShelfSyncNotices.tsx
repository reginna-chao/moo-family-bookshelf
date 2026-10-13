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

export interface PersonalShelfSyncNoticesProps {
  /** Live scrape progress; empty when no scrape is running. */
  progressMessage: string;
  /** Sync error to show; empty when the last sync did not fail. */
  syncError: string;
  /** Renamed / removed book counts of the last successful sync. */
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
    </>
  );
}
