import type { SyncCodeShare } from "@/hooks/useSyncCodeShare";

interface SettingsSyncCodeShareProps {
  share: SyncCodeShare;
}

/**
 * The 家庭同步碼 block: the code, 複製同步碼 and 邀請成員加入家庭. Stateless —
 * the confirmations are owned by `useSyncCodeShare` in the always-mounted
 * family section.
 */
export function SettingsSyncCodeShare({ share }: SettingsSyncCodeShareProps) {
  const { syncCode, copied, inviteCopied, handleCopy, handleInvite } = share;

  return (
    <>
      <p className="text-xs text-gray-500 mb-1">家庭同步碼</p>
      <div className="bg-gray-50 rounded-lg p-3 font-mono text-xs break-all mb-2">
        <span>{syncCode}</span>
      </div>
      <button
        onClick={() => void handleCopy()}
        className={`w-full rounded-lg border border-blue-600 px-4 py-2.5 text-sm font-semibold text-blue-600 ${
          copied ? "bg-blue-50" : "bg-transparent hover:bg-blue-50"
        } transition-colors`}
      >
        {copied ? "已複製" : "複製同步碼"}
      </button>
      <button
        onClick={() => void handleInvite()}
        className={`w-full rounded-lg border border-green-600 px-4 py-2.5 text-sm font-semibold text-green-600 mt-2 ${
          inviteCopied ? "bg-green-50" : "bg-transparent hover:bg-green-50"
        } transition-colors`}
      >
        {inviteCopied ? "已複製邀請連結" : "邀請成員加入家庭"}
      </button>
      <p className="text-gray-400 text-xs mt-1.5 mb-4">
        將此代碼或邀請連結分享給家人即可加入書櫃
      </p>
    </>
  );
}
