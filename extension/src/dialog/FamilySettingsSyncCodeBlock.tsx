import { Link, Check } from "lucide-react";
import { SyncCodeTextFrame } from "../secureFrame/frames";
import { InviteQrCode } from "./InviteQrCode";

export interface FamilySettingsSyncCodeBlockProps {
  syncCode: string | null;
  copied: boolean;
  inviteCopied: boolean;
  linkCopied: boolean;
  onCopy: () => Promise<void>;
  onInviteCopy: () => Promise<void>;
  onLinkCopy: () => Promise<void>;
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
  linkCopied,
  onCopy,
  onInviteCopy,
  onLinkCopy,
}: FamilySettingsSyncCodeBlockProps) {
  return (
    <div className="moo-settings__block">
      <div className="moo-settings__group-label">家庭同步碼</div>
      <div className="moo-settings__sync-code-box">
        {syncCode === null ? (
          <span
            data-testid="sync-code"
            className="moo-settings__sync-code-text"
          >
            載入中...
          </span>
        ) : (
          <SyncCodeTextFrame
            syncCode={syncCode}
            textClassName="moo-settings__sync-code-text"
          />
        )}
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
        <button
          type="button"
          onClick={() => void onLinkCopy()}
          disabled={!syncCode}
          aria-label={linkCopied ? "已複製邀請網址" : "複製邀請網址"}
          title="複製邀請網址"
          className={
            linkCopied
              ? "moo-button moo-button--outline-success moo-settings__link-btn moo-settings__link-btn--copied"
              : "moo-button moo-button--outline-success moo-settings__link-btn"
          }
        >
          {linkCopied ? (
            <Check size={18} aria-hidden="true" />
          ) : (
            <Link size={18} aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="moo-settings__hint">
        將同步碼或邀請連結分享給家人即可加入書櫃
      </div>
      {syncCode && <InviteQrCode syncCode={syncCode} />}
    </div>
  );
}
