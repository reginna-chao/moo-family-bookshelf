import { useState, useEffect, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ApiClient, BoolFlag } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";
import { useDisplayName } from "./useDisplayName";
import { useFloatingIconSize } from "./useFloatingIconSize";
import { FloatingIconSizeSelector } from "./FloatingIconSizeSelector";
import { useAutoSyncInterval } from "./useAutoSyncInterval";
import { AutoSyncIntervalSelector } from "./AutoSyncIntervalSelector";
import { DisplayNameEditor } from "./DisplayNameEditor";
import { MemberList } from "./MemberList";
import { EndpointSwitchPanel } from "./EndpointSwitchPanel";
import { useEndpointSwitch } from "./useEndpointSwitch";
import { DEFAULT_API_ENDPOINT, buildInviteUrl } from "../constants";
import {
  buildSyncCodeInviteMessage,
  buildLinkInviteMessage,
} from "moo-family-bookshelf-shared/invite/messages";
import { QrCodeLink } from "./QrCodeLink";
import { InviteQrCode } from "./InviteQrCode";
import { VerificationSettings } from "./VerificationSettings";
import { useFamilyData } from "./FamilyDataContext";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";
import { getReportLinks } from "moo-family-bookshelf-shared/config/links";

const reportLinks = getReportLinks({ appVersion: __APP_VERSION__ });

function sectionHeaderClass(open: boolean): string {
  return open
    ? "moo-settings__section-header moo-settings__section-header--open"
    : "moo-settings__section-header";
}

function switchTrackClass(on: boolean): string {
  return on ? "moo-switch__track moo-switch__track--on" : "moo-switch__track";
}

function switchKnobClass(on: boolean): string {
  return on ? "moo-switch__knob moo-switch__knob--on" : "moo-switch__knob";
}

// Map each report service to its brand-color hover modifier (see styles.css).
function reportLinkClass(name: string): string {
  const modifier =
    { GoogleForm: "--google", GitHub: "--github", Plurk: "--plurk" }[name] ??
    "";
  return modifier
    ? `moo-settings__report-link moo-settings__report-link${modifier}`
    : "moo-settings__report-link";
}

export interface FamilySettingsProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}
type LeaveState = "idle" | "confirming" | "leaving";
type DeleteState = "idle" | "confirming" | "deleting";

export function FamilySettings({
  familyId,
  userId,
  apiClient,
  onLeave,
}: FamilySettingsProps) {
  const {
    members,
    ownerId,
    membersState,
    membersError,
    familyEndpoint,
    refreshMembers: fetchMembers,
    refreshBookshelf,
  } = useFamilyData();

  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState(true);
  const [familyOpen, setFamilyOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState("");
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState("");
  const [syncArchived, setSyncArchived] = useState<number>(0);
  const { size: iconSize, setSize: setIconSize } = useFloatingIconSize();
  const { interval: autoSyncInterval, setInterval: setAutoSyncInterval } =
    useAutoSyncInterval();
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const selfMember = members.find((m) => m.userId === userId);
  // Pass the server's authoritative displayName from context. While members is
  // still loading, selfMember is undefined → useDisplayName falls back to
  // chrome.storage.local for an optimistic display.
  const initialDisplayName = selfMember?.displayName;
  const displayNameState = useDisplayName({
    apiClient,
    familyId,
    userId,
    initialDisplayName,
  });

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      if (inviteCopiedTimerRef.current !== null)
        clearTimeout(inviteCopiedTimerRef.current);
    };
  }, []);

  const membersLoading = membersState === "loading";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GET_SYNC_ARCHIVED",
        })) as { syncArchived?: number } | undefined;
        if (cancelled) return;
        if (response?.syncArchived !== undefined) {
          setSyncArchived(response.syncArchived);
        }
      } catch {
        // Background unavailable — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleSyncArchived = useCallback(() => {
    const prev = syncArchived;
    const newValue = prev === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
    setSyncArchived(newValue);
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_SYNC_ARCHIVED",
          syncArchived: newValue,
        })) as { ok?: boolean } | undefined;
        if (!response?.ok) {
          setSyncArchived(prev);
        }
      } catch {
        setSyncArchived(prev);
      }
    })();
  }, [syncArchived]);

  // The family record's apiEndpoint is owner-controlled and pushed to every
  // member, so it is never adopted silently — the user confirms each switch.
  const endpointSwitch = useEndpointSwitch({
    apiClient,
    familyEndpoint,
    membersReady: membersState === "ready",
  });
  const { adoptedEndpoint } = endpointSwitch;

  // Build the sync code / invite / QR from the endpoint THIS device has ADOPTED,
  // never from the family record's value: a member who declined a switch must
  // not distribute (or re-scan into a second device) the endpoint they refused.
  // adoptedEndpoint is state, so a confirmed switch refreshes the code in place.
  useEffect(() => {
    const apiHost =
      adoptedEndpoint === DEFAULT_API_ENDPOINT ? undefined : adoptedEndpoint;
    setSyncCode(encodeSyncCode({ familyId, apiHost }));
  }, [familyId, adoptedEndpoint]);

  const handleCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(buildSyncCodeInviteMessage(syncCode));
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleInviteCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(
      buildLinkInviteMessage(buildInviteUrl(syncCode)),
    );
    setInviteCopied(true);
    if (inviteCopiedTimerRef.current !== null)
      clearTimeout(inviteCopiedTimerRef.current);
    inviteCopiedTimerRef.current = setTimeout(
      () => setInviteCopied(false),
      2000,
    );
  };

  const handleLeaveConfirm = async () => {
    setLeaveState("leaving");
    setLeaveError("");
    try {
      const response = await apiClient.leaveFamily(familyId, userId);
      if (response.error) {
        // 429 shows the localized back-off copy (with the wait when the server
        // sent one) instead of the server's English message.
        const msg =
          response.error.code === "OWNER_CANNOT_LEAVE"
            ? "管理者必須先轉移管理權才能離開家庭"
            : (rateLimitedEnvelopeMessage(response.error) ??
              response.error.message);
        setLeaveError(msg);
        setLeaveState("idle");
        return;
      }
      onLeave();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "發生未知錯誤");
      setLeaveState("idle");
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteState("deleting");
    setDeleteError("");
    try {
      const response = await apiClient.deleteAccount(userId);
      if (response.error) {
        const msg =
          response.error.code === "OWNER_CANNOT_DELETE"
            ? "管理者必須先轉移管理權才能移除帳戶"
            : response.error.message;
        setDeleteError(msg);
        setDeleteState("idle");
        return;
      }
      // Best-effort local cleanup: the server account is already deleted and
      // non-reversible, so the server state is the source of truth. A failure
      // to clear local storage must not block onLeave() or surface as an error.
      try {
        await browser.storage.local.clear();
      } catch (clearErr) {
        console.warn(
          "[FamilySettings] Failed to clear local storage after account deletion",
          clearErr,
        );
      }
      onLeave();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "發生未知錯誤");
      setDeleteState("idle");
    }
  };

  return (
    <div>
      <EndpointSwitchPanel
        pending={endpointSwitch.pending}
        confirmError={endpointSwitch.confirmError}
        onConfirm={endpointSwitch.confirm}
        onDecline={endpointSwitch.decline}
        onDismissConfirmError={endpointSwitch.dismissConfirmError}
      />
      <button
        onClick={() => setPersonalOpen(!personalOpen)}
        aria-expanded={personalOpen}
        className={sectionHeaderClass(personalOpen)}
      >
        {personalOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        個人設定
      </button>
      {personalOpen && (
        <>
          <DisplayNameEditor {...displayNameState} userId={userId} />
          <div className="moo-settings__block">
            <button
              role="switch"
              aria-checked={syncArchived === BoolFlag.TRUE}
              aria-label="同步封存書籍"
              onClick={handleToggleSyncArchived}
              className="moo-switch"
            >
              <span
                className={switchTrackClass(syncArchived === BoolFlag.TRUE)}
              >
                <span
                  className={switchKnobClass(syncArchived === BoolFlag.TRUE)}
                />
              </span>
              同步封存書籍
            </button>
            <div className="moo-settings__hint">
              啟用後，同步時會一併讀取已封存的書籍
            </div>
          </div>
          <div className="moo-settings__block">
            <div className="moo-settings__label">自動同步頻率</div>
            <AutoSyncIntervalSelector
              value={autoSyncInterval}
              onChange={setAutoSyncInterval}
            />
            <div className="moo-settings__hint">
              家庭書櫃自動讀取書單的頻率；手動同步不受此限制
            </div>
          </div>
          <div className="moo-settings__block">
            <div className="moo-settings__label">家庭書櫃按鈕大小</div>
            <FloatingIconSizeSelector size={iconSize} onChange={setIconSize} />
            <div className="moo-settings__hint">
              在讀墨頁面顯示的家庭書櫃按鈕大小
            </div>
          </div>
        </>
      )}
      <div className="moo-settings__divider" />
      <button
        onClick={() => setFamilyOpen(!familyOpen)}
        aria-expanded={familyOpen}
        className={sectionHeaderClass(familyOpen)}
      >
        {familyOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        家庭設定
      </button>
      {familyOpen && (
        <>
          <div className="moo-settings__block">
            <div className="moo-settings__group-label">家庭同步碼</div>
            <div className="moo-settings__sync-code-box">
              <span
                data-testid="sync-code"
                className="moo-settings__sync-code-text"
              >
                {syncCode ?? "載入中..."}
              </span>
            </div>
            <div className="moo-settings__copy-row">
              <button
                onClick={handleCopy}
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
                onClick={() => void handleInviteCopy()}
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
          <div className="moo-settings__block">
            <div className="moo-settings__group-label moo-settings__group-label--members">
              家庭成員
              {!membersLoading && !membersError ? ` (${members.length})` : ""}
            </div>
            {membersLoading && (
              <div className="moo-settings__members-loading">載入中...</div>
            )}
            {!membersLoading && membersError && (
              <div className="moo-settings__members-error">
                <div className="moo-settings__error-text">{membersError}</div>
                <button
                  onClick={() => void fetchMembers()}
                  className="moo-button moo-button--outline moo-settings__retry-btn"
                >
                  重試
                </button>
              </div>
            )}
            {!membersLoading && !membersError && (
              <MemberList
                members={members}
                ownerId={ownerId}
                userId={userId}
                familyId={familyId}
                apiClient={apiClient}
                onMembersChanged={() => {
                  void fetchMembers();
                  void refreshBookshelf();
                }}
                familyEndpoint={familyEndpoint}
              />
            )}
            <div className="moo-settings__hint">
              基於讀墨家庭帳戶限制，每個家庭最多 2 位成員
            </div>
          </div>
        </>
      )}
      <div className="moo-settings__block">
        {leaveError && (
          <div className="moo-settings__error-text">{leaveError}</div>
        )}
        {leaveState === "idle" && (
          <button
            onClick={() => setLeaveState("confirming")}
            className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
          >
            離開家庭
          </button>
        )}
        {leaveState === "confirming" && (
          <div>
            <div className="moo-settings__confirm-prompt">確定要離開嗎？</div>
            <div className="moo-settings__confirm-row">
              <button
                onClick={() => void handleLeaveConfirm()}
                className="moo-button moo-button--danger moo-settings__confirm-yes"
              >
                確定離開
              </button>
              <button
                onClick={() => setLeaveState("idle")}
                className="moo-button moo-button--ghost moo-settings__confirm-no"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {leaveState === "leaving" && (
          <button
            disabled
            className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
          >
            離開中...
          </button>
        )}
      </div>
      <div className="moo-settings__section-divider">
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-expanded={mobileOpen}
          className={sectionHeaderClass(mobileOpen)}
        >
          {mobileOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          手機版登入
        </button>
        {mobileOpen && (
          <>
            {syncCode && (
              <QrCodeLink
                syncCode={syncCode}
                userId={userId}
                apiClient={apiClient}
              />
            )}
            <VerificationSettings userId={userId} apiClient={apiClient} />
          </>
        )}
      </div>
      <div className="moo-settings__section-divider--spaced">
        {deleteError && (
          <div className="moo-settings__error-text">{deleteError}</div>
        )}
        {deleteState === "idle" && (
          <button
            onClick={() => setDeleteState("confirming")}
            className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
          >
            移除帳戶
          </button>
        )}
        {deleteState === "confirming" && (
          <div>
            <div className="moo-settings__delete-warning">
              <div className="moo-settings__delete-warning-title">
                確定要移除帳戶嗎？
              </div>
              <ul className="moo-settings__delete-warning-list">
                <li>將移除墨家書櫃中的所有資料</li>
                <li>不影響你的讀墨帳號及書籍</li>
                <li>下次登入時將重新設定</li>
              </ul>
            </div>
            <div className="moo-settings__confirm-row">
              <button
                onClick={() => void handleDeleteConfirm()}
                className="moo-button moo-button--danger moo-settings__confirm-yes"
              >
                確定移除
              </button>
              <button
                onClick={() => {
                  setDeleteState("idle");
                  setDeleteError("");
                }}
                className="moo-button moo-button--ghost moo-settings__confirm-no"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {deleteState === "deleting" && (
          <button
            disabled
            className="moo-button moo-button--outline-danger moo-button--block moo-settings__danger-btn"
          >
            移除中...
          </button>
        )}
      </div>
      <div className="moo-settings__report">
        <div className="moo-settings__report-label">問題回報</div>
        <div className="moo-settings__report-links">
          {reportLinks.map((link) => (
            <a
              key={link.name}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.name}
              className={reportLinkClass(link.name)}
            >
              <svg
                aria-hidden="true"
                role="img"
                viewBox="0 0 24 24"
                width={24}
                height={24}
                fill="currentColor"
              >
                <path d={link.svgPath} />
              </svg>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
