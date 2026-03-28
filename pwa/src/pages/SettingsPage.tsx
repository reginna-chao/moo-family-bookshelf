import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { ApiClient, FamilyMember } from "@/api/client";
import { encodeSyncCode } from "@/crypto/syncCode";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { MemberList } from "@/components/MemberList";
import { ApiEndpointEditor } from "@/components/ApiEndpointEditor";

const SYNC_ARCHIVED_KEY = "moo:syncArchived";

interface SettingsPageProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  encryptionKey: string;
  onLogout: () => void;
}

type LeaveState = "idle" | "confirming" | "leaving";

export function SettingsPage({
  familyId,
  userId,
  apiClient,
  encryptionKey,
  onLogout,
}: SettingsPageProps) {
  // --- Sync archived setting ---
  const [syncArchived, setSyncArchived] = useState<0 | 1>(() => {
    const stored = localStorage.getItem(SYNC_ARCHIVED_KEY);
    return stored === "1" ? 1 : 0;
  });

  const handleToggleSyncArchived = useCallback(() => {
    setSyncArchived(prev => {
      const next = prev === 1 ? 0 : 1;
      localStorage.setItem(SYNC_ARCHIVED_KEY, String(next));
      return next as 0 | 1;
    });
  }, []);

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

  // --- Logout ---
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  function handleLogout() {
    if (showLogoutConfirm) {
      onLogout();
    } else {
      setShowLogoutConfirm(true);
    }
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">設定</h2>

      {/* Personal settings */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-3">個人設定</h3>
        <button
          role="switch"
          aria-checked={syncArchived === 1}
          aria-label="顯示封存書籍"
          onClick={handleToggleSyncArchived}
          className="flex items-center gap-2 text-sm text-gray-700"
        >
          <span
            className={`relative inline-block w-8 h-[18px] rounded-full transition-colors ${
              syncArchived === 1 ? "bg-blue-600" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-0.5 block w-3.5 h-3.5 rounded-full bg-white transition-[left] ${
                syncArchived === 1 ? "left-[16px]" : "left-0.5"
              }`}
            />
          </span>
          顯示封存書籍
        </button>
        <p className="text-gray-400 text-xs mt-1.5">
          啟用後，個人書櫃會顯示已封存的書籍分頁
        </p>
      </section>

      {/* Sync code */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-2">家庭同步碼</h3>
        <div className="bg-gray-50 rounded-lg p-3 font-mono text-xs break-all mb-2">
          {syncCode}
        </div>
        <button
          onClick={() => void handleCopy()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
        >
          {copied ? "已複製" : "複製同步碼"}
        </button>
        <p className="text-gray-400 text-xs mt-1.5">
          將此代碼分享給家人即可加入書櫃
        </p>
      </section>

      {/* Members */}
      <section className="mb-6">
        <h3 className="text-sm font-medium text-gray-500 mb-2">
          成員{!membersLoading && !membersError ? ` (${members.length})` : ""}
        </h3>
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
      </section>

      {/* API Endpoint */}
      <ApiEndpointEditor apiClient={apiClient} />

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
        {showLogoutConfirm ? (
          <div>
            <p className="text-sm text-gray-600 mb-2">
              確定要登出嗎？登出後需要重新輸入同步碼才能使用。
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
    </div>
  );
}
