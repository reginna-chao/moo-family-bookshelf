import { InviteQrCode } from "./InviteQrCode";

export interface FamilySettingsSyncCodeBlockProps {
  syncCode: string | null;
  copied: boolean;
  inviteCopied: boolean;
  onCopy: () => Promise<void>;
  onInviteCopy: () => Promise<void>;
}

/**
 * 家庭同步碼 block of the 家庭設定 section. Stateless: the copied flags and
 * their timers live in `FamilySettings` (via `useFamilySettingsCopy`), so
 * collapsing the section mid-feedback does not reset them.
 */
export function FamilySettingsSyncCodeBlock({
  syncCode,
  copied,
  inviteCopied,
  onCopy,
  onInviteCopy,
}: FamilySettingsSyncCodeBlockProps) {
  return (
    <div className="moo-settings__block">
      <div className="moo-settings__group-label">家庭同步碼</div>
      <div className="moo-settings__sync-code-box">
        <span data-testid="sync-code" className="moo-settings__sync-code-text">
          {syncCode ?? "載入中..."}
        </span>
      </div>
      <div className="moo-settings__copy-row">
        <button
          onClick={onCopy}
          disabled={!syncCode}
          className={
            copied
              ? "moo-button moo-button--outline moo-settings__copy-btn moo-settings__copy-btn--copied"
              : "moo-button moo-button--outline moo-settings__copy-btn"
          }
        >
          {copied ? "已複製" : "複製同步碼"}
        </button>
        <button
          onClick={() => void onInviteCopy()}
          disabled={!syncCode}
          className={
            inviteCopied
              ? "moo-button moo-button--outline-success moo-settings__invite-btn moo-settings__invite-btn--copied"
              : "moo-button moo-button--outline-success moo-settings__invite-btn"
          }
        >
          {inviteCopied ? "已複製邀請連結" : "邀請成員加入家庭"}
        </button>
      </div>
      <div className="moo-settings__hint">
        將同步碼或邀請連結分享給家人即可加入書櫃
      </div>
      {syncCode && <InviteQrCode syncCode={syncCode} />}
    </div>
  );
}
