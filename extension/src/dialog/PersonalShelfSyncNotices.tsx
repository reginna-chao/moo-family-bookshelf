/** Notice shown after a sync moved books to their new Readmoo id (#236). */
export function renamedBooksNotice(count: number): string {
  return `讀墨更換了 ${count} 本書的編號，書櫃已改用新編號，分享設定維持原本的選擇`;
}

export interface PersonalShelfSyncNoticesProps {
  /** Live scrape progress; empty when no scrape is running. */
  progressMessage: string;
  /** Sync error to show; empty when the last sync did not fail. */
  syncError: string;
  /** Books the last successful sync moved to a new Readmoo id. */
  renamedBookCount: number;
}

/** Sync status lines under the personal-shelf header. */
export function PersonalShelfSyncNotices({
  progressMessage,
  syncError,
  renamedBookCount,
}: PersonalShelfSyncNoticesProps) {
  return (
    <>
      {progressMessage && (
        <div className="moo-shelf__progress">{progressMessage}</div>
      )}
      {syncError && <p className="moo-shelf__sync-error">{syncError}</p>}
      {renamedBookCount > 0 && (
        <p role="status" className="moo-shelf__sync-notice">
          {renamedBooksNotice(renamedBookCount)}
        </p>
      )}
    </>
  );
}
