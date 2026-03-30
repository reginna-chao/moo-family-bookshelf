import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Pencil, Check, X } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { ApiClient, FamilyMember } from "@/api/client";
import { encodeSyncCode } from "@/crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { MemberList } from "@/components/MemberList";
import { ApiEndpointEditor } from "@/components/ApiEndpointEditor";
import { namespacedKey, REMEMBER_SYNC_CODE_KEY } from "@/hooks/useAuth";

interface SettingsPageProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  encryptionKey: string;
  onLogout: () => void;
  onForceLogout: () => void;
}

type LeaveState = "idle" | "confirming" | "leaving";
type DeleteState = "idle" | "confirming" | "deleting";

export function SettingsPage({
  familyId,
  userId,
  apiClient,
  encryptionKey,
  onLogout,
  onForceLogout,
}: SettingsPageProps) {
  // --- Sync archived setting ---
  const syncArchivedKey = namespacedKey(userId, "syncArchived");
  const [syncArchived, setSyncArchived] = useState<BoolFlag>(() => {
    const stored = localStorage.getItem(syncArchivedKey);
    return stored === "1" ? BoolFlag.TRUE : BoolFlag.FALSE;
  });

  const handleToggleSyncArchived = useCallback(() => {
    setSyncArchived(prev => {
      const next = prev === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
      localStorage.setItem(syncArchivedKey, String(next));
      return next;
    });
  }, [syncArchivedKey]);

  // --- Sync code ---
  const syncCode = useMemo(
    () =>
      encodeSyncCode({
        familyId,
        encryptionKey,
        apiHost:
          apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT
            ? apiClient.getEndpoint()
            : undefined,
      }),
    [familyId, encryptionKey, apiClient],
  );
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(syncCode);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API failed — ignore silently on mobile
    }
  }

  // --- Members ---
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [ownerId, setOwnerId] = useState("");
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const res = await apiClient.getFamilyMembers(familyId);
      if (res.error) {
        setMembersError(res.error.message);
      } else if (res.data) {
        setMembers(res.data.members);
        setOwnerId(res.data.ownerId);
      }
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setMembersLoading(false);
    }
  }, [apiClient, familyId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  // --- Display name ---
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [currentName, setCurrentName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    const self = members.find(m => m.userId === userId);
    if (self) {
      setCurrentName(self.displayName || "");
    }
  }, [members, userId]);

  const handleSaveName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === currentName) {
      setEditingName(false);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    try {
      const res = await apiClient.updateDisplayName(familyId, userId, trimmed);
      if (res.error) {
        setNameError(res.error.message);
        setNameSaving(false);
        return;
      }
      setCurrentName(trimmed);
      setEditingName(false);
      window.dispatchEvent(
        new CustomEvent("displayNameChanged", { detail: { displayName: trimmed } }),
      );
      void loadMembers();
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setNameSaving(false);
    }
  }, [nameInput, currentName, apiClient, familyId, userId, loadMembers]);

  // --- Leave family ---
  const [leaveState, setLeaveState] = useState<LeaveState>("idle");
  const [leaveError, setLeaveError] = useState<string | null>(null);

  async function handleLeave() {
    setLeaveState("leaving");
    setLeaveError(null);
    try {
      const res = await apiClient.leaveFamily(familyId, userId);
      if (res.error) {
        const msg =
          res.error.code === "OWNER_CANNOT_LEAVE"
            ? "管理者必須先轉移管理權才能離開家庭"
            : res.error.message;
        setLeaveError(msg);
        setLeaveState("idle");
        return;
      }
      onLogout();
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : "離開失敗");
      setLeaveState("idle");
    }
  }

  // --- Remember sync code toggle ---
  const [rememberSyncCode, setRememberSyncCode] = useState<BoolFlag>(() => {
    const stored = localStorage.getItem(REMEMBER_SYNC_CODE_KEY);
    return stored === "1" ? BoolFlag.TRUE : BoolFlag.FALSE;
  });

  const handleToggleRememberSyncCode = useCallback(() => {
    setRememberSyncCode(prev => {
      const next = prev === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
      localStorage.setItem(REMEMBER_SYNC_CODE_KEY, String(next));
      return next;
    });
  }, []);

  // --- Logout ---
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  function handleLogout() {
    if (showLogoutConfirm) {
      onLogout();
    } else {
      setShowLogoutConfirm(true);
    }
  }

  // --- Delete account ---
  const [deleteState, setDeleteState] = useState<DeleteState>("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeleteAccount() {
    setDeleteState("deleting");
    setDeleteError(null);
    try {
      const res = await apiClient.deleteAccount(userId);
      if (res.error) {
        const msg =
          res.error.code === "OWNER_CANNOT_DELETE"
            ? "管理者必須先轉移管理權才能移除帳戶"
            : res.error.message;
        setDeleteError(msg);
        setDeleteState("idle");
        return;
      }
      onForceLogout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "移除失敗");
      setDeleteState("idle");
    }
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">設定</h2>

      {/* Personal settings */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">個人設定</h3>

        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-1">顯示名稱</p>
          {editingName ? (
            <div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={20}
                  placeholder="輸入顯示名稱"
                  aria-label="顯示名稱"
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
                />
                <button
                  onClick={() => void handleSaveName()}
                  disabled={nameSaving}
                  aria-label="確認修改名稱"
                  className="p-1.5 text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  <Check size={16} />
                </button>
                <button
                  onClick={() => { setEditingName(false); setNameError(null); }}
                  disabled={nameSaving}
                  aria-label="取消修改名稱"
                  className="p-1.5 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                >
                  <X size={16} />
                </button>
              </div>
              {nameError && (
                <p role="alert" className="text-red-500 text-xs mt-1">{nameError}</p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">
                {currentName || userId.slice(0, 8)}
              </span>
              <button
                onClick={() => { setNameInput(currentName); setEditingName(true); }}
                aria-label="編輯顯示名稱"
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>

        <button
          role="switch"
          aria-checked={syncArchived === BoolFlag.TRUE}
          aria-label="顯示封存書籍"
          onClick={handleToggleSyncArchived}
          className="flex items-center gap-2 text-sm text-gray-700"
        >
          <span
            className={`relative inline-block w-8 h-[18px] rounded-full transition-colors ${
              syncArchived === BoolFlag.TRUE ? "bg-blue-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-0.5 block w-3.5 h-3.5 rounded-full bg-white transition-[left] ${
                syncArchived === BoolFlag.TRUE ? "left-[16px]" : "left-0.5"
              }`}
            />
          </span>
          顯示封存書籍
        </button>
        <p className="text-gray-400 text-xs mt-1.5">
          啟用後，個人書櫃會顯示已封存的書籍分頁
        </p>
      </section>

      {/* Family settings */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">家庭設定</h3>

        <p className="text-xs text-gray-500 mb-1">家庭同步碼</p>
        <div className="bg-gray-50 rounded-lg p-3 font-mono text-xs break-all mb-2">
          {syncCode}
        </div>
        <button
          onClick={() => void handleCopy()}
          className={`w-full rounded-lg border border-blue-600 px-4 py-2 text-sm font-semibold text-blue-600 ${
            copied ? "bg-blue-50" : "bg-transparent hover:bg-blue-50"
          } transition-colors`}
        >
          {copied ? "已複製" : "複製同步碼"}
        </button>
        <p className="text-gray-400 text-xs mt-1.5 mb-4">
          將此代碼分享給家人即可加入書櫃
        </p>

        <p className="text-xs text-gray-500 mb-1">
          成員{!membersLoading && !membersError ? ` (${members.length})` : ""}
        </p>
        {membersLoading && (
          <p className="text-gray-400 text-sm">載入中...</p>
        )}
        {membersError && (
          <div>
            <p role="alert" className="text-red-500 text-sm mb-2">{membersError}</p>
            <button
              onClick={() => void loadMembers()}
              className="text-sm font-semibold text-blue-600"
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
            onMembersChanged={loadMembers}
          />
        )}
        <p className="text-gray-400 text-xs mt-1.5">
          基於讀墨家庭帳戶限制，每個家庭最多 2 位成員
        </p>

        <div className="mt-4">
          <ApiEndpointEditor apiClient={apiClient} userId={userId} />
        </div>
      </section>

      {/* Leave family */}
      <section className="mb-6 pt-6 border-t border-gray-200">
        {leaveError && (
          <p role="alert" className="text-red-500 text-sm mb-2">{leaveError}</p>
        )}
        {leaveState === "idle" && (
          <button
            onClick={() => setLeaveState("confirming")}
            className="w-full rounded-lg border border-orange-300 py-2.5 text-sm font-medium text-orange-600 hover:bg-orange-50 transition-colors"
          >
            離開家庭
          </button>
        )}
        {leaveState === "confirming" && (
          <div className="flex gap-2">
            <button
              onClick={() => void handleLeave()}
              className="flex-1 rounded-lg bg-orange-600 py-2.5 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
            >
              確定離開
            </button>
            <button
              onClick={() => {
                setLeaveState("idle");
                setLeaveError(null);
              }}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
            >
              取消
            </button>
          </div>
        )}
        {leaveState === "leaving" && (
          <button
            disabled
            className="w-full rounded-lg bg-orange-400 py-2.5 text-sm font-medium text-white opacity-50 cursor-not-allowed"
          >
            離開中...
          </button>
        )}
      </section>

      {/* Logout */}
      <section className="pt-6 border-t border-gray-200">
        <div className="mb-4">
          <button
            role="switch"
            aria-checked={rememberSyncCode === BoolFlag.TRUE}
            aria-label="登出時記住同步碼"
            onClick={handleToggleRememberSyncCode}
            className="flex items-center gap-2 text-sm text-gray-700"
          >
            <span
              className={`relative inline-block w-8 h-[18px] rounded-full transition-colors ${
                rememberSyncCode === BoolFlag.TRUE ? "bg-blue-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`absolute top-0.5 block w-3.5 h-3.5 rounded-full bg-white transition-[left] ${
                  rememberSyncCode === BoolFlag.TRUE ? "left-[16px]" : "left-0.5"
                }`}
              />
            </span>
            登出時記住同步碼
          </button>
          <p className="text-gray-400 text-xs mt-1.5">
            啟用後，登出時會保留同步碼，下次登入免重新輸入
          </p>
        </div>

        {showLogoutConfirm ? (
          <div>
            <p className="text-sm text-gray-600 mb-2">
              {rememberSyncCode === BoolFlag.TRUE
                ? "確定要登出嗎？同步碼已保留，下次登入免重新輸入。"
                : "確定要登出嗎？登出後需要重新輸入同步碼才能使用。"}
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleLogout}
                className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                確定登出
              </button>
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleLogout}
            className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
          >
            登出
          </button>
        )}
      </section>

      {/* Delete account */}
      <section className="mb-6 pt-6 border-t border-gray-200">
        {deleteError && (
          <p role="alert" className="text-red-500 text-sm mb-2">{deleteError}</p>
        )}
        {deleteState === "idle" && (
          <button
            onClick={() => setDeleteState("confirming")}
            className="w-full rounded-lg border border-red-300 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
          >
            移除帳戶
          </button>
        )}
        {deleteState === "confirming" && (
          <div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
              <p className="text-sm font-bold text-red-700 mb-2">確定要移除帳戶嗎？</p>
              <ul className="text-xs text-red-600 list-disc list-inside space-y-1">
                <li>將移除牧家書櫃中的所有資料</li>
                <li>不影響你的讀墨帳號及書籍</li>
                <li>下次登入時將重新設定</li>
              </ul>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void handleDeleteAccount()}
                className="flex-1 rounded-lg bg-red-600 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                確定移除
              </button>
              <button
                onClick={() => {
                  setDeleteState("idle");
                  setDeleteError(null);
                }}
                className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {deleteState === "deleting" && (
          <button
            disabled
            className="w-full rounded-lg bg-red-400 py-2.5 text-sm font-medium text-white opacity-50 cursor-not-allowed"
          >
            移除中...
          </button>
        )}
      </section>

      {/* About */}
      <section className="pt-6 mt-6 border-t border-gray-200 text-center">
        <p className="text-xs text-gray-400">
          牧家書櫃 v{__APP_VERSION__}
        </p>
        <p className="text-[10px] text-gray-300 mt-1">
          本程式為第三方開發，非 Readmoo 讀墨官方提供。
        </p>
      </section>
    </div>
  );
}
