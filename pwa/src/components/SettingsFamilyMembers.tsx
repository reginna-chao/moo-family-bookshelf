import type { Dispatch, SetStateAction } from "react";
import type { ApiClient } from "@/api/client";
import { MemberList, type RemovedMemberInfo } from "@/components/MemberList";
import { UnkickNotice } from "@/components/UnkickNotice";
import { useFamilyData } from "@/hooks/useFamilyData";

interface SettingsFamilyMembersProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  recentlyRemoved: RemovedMemberInfo | null;
  setRecentlyRemoved: Dispatch<SetStateAction<RemovedMemberInfo | null>>;
}

/**
 * The 成員 block of 家庭設定: count, loading / error-with-retry, the member
 * list, and the un-kick entry for the member just removed. The removal record
 * is owned by the always-mounted family section, because this block unmounts
 * whenever that section is collapsed.
 */
export function SettingsFamilyMembers({
  familyId,
  userId,
  apiClient,
  recentlyRemoved,
  setRecentlyRemoved,
}: SettingsFamilyMembersProps) {
  // --- Members (from Context) ---
  const {
    members,
    ownerId,
    membersState,
    membersError: ctxMembersError,
    refreshMembers: loadMembers,
    refreshBookshelf,
  } = useFamilyData();
  const membersLoading = membersState === "loading";
  const membersError = ctxMembersError || null;

  return (
    <>
      <p className="text-xs text-gray-500 mb-1">
        成員
        {!membersLoading && !membersError ? ` (${members.length})` : ""}
      </p>
      {membersLoading && <p className="text-gray-400 text-sm">載入中...</p>}
      {membersError && (
        <div>
          <p role="alert" className="text-red-500 text-sm mb-2">
            {membersError}
          </p>
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
          onMembersChanged={() => {
            void loadMembers();
            void refreshBookshelf();
          }}
          onMemberRemoved={setRecentlyRemoved}
        />
      )}
      {/* Outside the loading/error guard on purpose: the removal already
          succeeded, so the entry must survive a failed member refresh.
          `key` resets the notice's own request state per REMOVAL, not per
          target: removing the same member again (after an un-kick and a
          rejoin) must not leave the card stuck in its "cleared" state. */}
      {recentlyRemoved && userId === ownerId && (
        <div className="px-3 py-2.5">
          <UnkickNotice
            key={`${recentlyRemoved.userId}:${recentlyRemoved.removedAt}`}
            familyId={familyId}
            targetUserId={recentlyRemoved.userId}
            displayName={recentlyRemoved.displayName}
            apiClient={apiClient}
            onDismiss={() => setRecentlyRemoved(null)}
          />
        </div>
      )}
      <p className="text-gray-400 text-xs mt-1.5">
        基於讀墨家庭帳戶限制，每個家庭最多 2 位成員
      </p>
    </>
  );
}
