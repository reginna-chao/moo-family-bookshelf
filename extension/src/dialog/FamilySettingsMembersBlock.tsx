import type { ApiClient } from "../api/client";
import { MemberList, type RemovedMemberInfo } from "./MemberList";
import { UnkickNotice } from "./UnkickNotice";
import { useFamilyData } from "./FamilyDataContext";

export interface FamilySettingsMembersBlockProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  /** Owned by `FamilySettings` — see the note on its `recentlyRemoved` state. */
  recentlyRemoved: RemovedMemberInfo | null;
  onMemberRemoved: (removed: RemovedMemberInfo) => void;
  onDismissRemoved: () => void;
}

/**
 * 家庭成員 block of the 家庭設定 section. Member data comes straight from
 * `FamilyDataContext`; the only state it renders from props is the
 * recently-removed entry, which must outlive this block's unmount.
 */
export function FamilySettingsMembersBlock({
  familyId,
  userId,
  apiClient,
  recentlyRemoved,
  onMemberRemoved,
  onDismissRemoved,
}: FamilySettingsMembersBlockProps) {
  const {
    members,
    ownerId,
    membersState,
    membersError,
    familyEndpoint,
    refreshMembers: fetchMembers,
    refreshBookshelf,
  } = useFamilyData();
  const membersLoading = membersState === "loading";

  return (
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
          onMemberRemoved={onMemberRemoved}
          familyEndpoint={familyEndpoint}
        />
      )}
      {/* Outside the loading/error guard: the entry must survive a failed refresh. `key` resets per
          REMOVAL, so removing the same member again never leaves the card stuck "cleared". */}
      {recentlyRemoved && userId === ownerId && (
        <UnkickNotice
          key={`${recentlyRemoved.userId}:${recentlyRemoved.removedAt}`}
          familyId={familyId}
          targetUserId={recentlyRemoved.userId}
          displayName={recentlyRemoved.displayName}
          apiClient={apiClient}
          onDismiss={onDismissRemoved}
        />
      )}
      <div className="moo-settings__hint">
        基於讀墨家庭帳戶限制，每個家庭最多 2 位成員
      </div>
    </div>
  );
}
