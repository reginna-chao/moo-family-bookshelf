import { useState, useEffect } from "react";
import { ApiClient } from "../api/client";
import { encodeSyncCode } from "../crypto/syncCode";
import { useDisplayName } from "./useDisplayName";
import { useFloatingIconSize } from "./useFloatingIconSize";
import { useAutoSyncInterval } from "./useAutoSyncInterval";
import type { RemovedMemberInfo } from "./MemberList";
import { EndpointSwitchPanel } from "./EndpointSwitchPanel";
import { useEndpointSwitch } from "./useEndpointSwitch";
import { DEFAULT_API_ENDPOINT } from "../constants";
import { QrCodeLink } from "./QrCodeLink";
import { VerificationSettings } from "./VerificationSettings";
import { useFamilyData } from "./FamilyDataContext";
import { FamilySettingsSectionHeader } from "./FamilySettingsSectionHeader";
import { FamilySettingsPersonalBlock } from "./FamilySettingsPersonalBlock";
import { FamilySettingsSyncCodeBlock } from "./FamilySettingsSyncCodeBlock";
import { FamilySettingsMembersBlock } from "./FamilySettingsMembersBlock";
import { FamilySettingsLeaveBlock } from "./FamilySettingsLeaveBlock";
import { FamilySettingsDeleteBlock } from "./FamilySettingsDeleteBlock";
import { FamilySettingsReportLinks } from "./FamilySettingsReportLinks";
import { useFamilySettingsCopy } from "./useFamilySettingsCopy";
import { useFamilySettingsSyncArchived } from "./useFamilySettingsSyncArchived";

export interface FamilySettingsProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLeave: () => void;
}

export function FamilySettings({
  familyId,
  userId,
  apiClient,
  onLeave,
}: FamilySettingsProps) {
  const { members, membersState, familyEndpoint } = useFamilyData();

  const [syncCode, setSyncCode] = useState<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState(true);
  const [familyOpen, setFamilyOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(true);
  /** Latest member removed in THIS dialog session, only for `UnkickNotice`'s entry (closing forgets
   *  it; a new removal replaces it). Held here so a failed refresh unmounting MemberList keeps it. */
  const [recentlyRemoved, setRecentlyRemoved] =
    useState<RemovedMemberInfo | null>(null);
  const { size: iconSize, setSize: setIconSize } = useFloatingIconSize();
  const { interval: autoSyncInterval, setInterval: setAutoSyncInterval } =
    useAutoSyncInterval();
  const selfMember = members.find((m) => m.userId === userId);
  // The server's displayName from context; while members load it is undefined and useDisplayName
  // shows chrome.storage.local's value optimistically.
  const initialDisplayName = selfMember?.displayName;
  const displayNameState = useDisplayName({
    apiClient,
    familyId,
    userId,
    initialDisplayName,
  });

  // Hook call order is load-bearing: effects run copy-timer cleanup → GET_SYNC_ARCHIVED →
  // endpoint switch → sync code.
  const { copied, inviteCopied, handleCopy, handleInviteCopy } =
    useFamilySettingsCopy(syncCode);
  const { syncArchived, handleToggleSyncArchived } =
    useFamilySettingsSyncArchived();

  // The family record's apiEndpoint is owner-controlled and pushed to every
  // member, so it is never adopted silently — the user confirms each switch.
  const endpointSwitch = useEndpointSwitch({
    apiClient,
    familyEndpoint,
    membersReady: membersState === "ready",
  });
  const { adoptedEndpoint } = endpointSwitch;

  // Sync code / invite / QR use the endpoint THIS device ADOPTED, never the record's: a member must
  // not hand out the endpoint they declined. Being state, a confirmed switch refreshes it in place.
  useEffect(() => {
    const apiHost =
      adoptedEndpoint === DEFAULT_API_ENDPOINT ? undefined : adoptedEndpoint;
    setSyncCode(encodeSyncCode({ familyId, apiHost }));
  }, [familyId, adoptedEndpoint]);

  return (
    <div>
      <EndpointSwitchPanel
        pending={endpointSwitch.pending}
        confirmError={endpointSwitch.confirmError}
        onConfirm={endpointSwitch.confirm}
        onDecline={endpointSwitch.decline}
        onDismissConfirmError={endpointSwitch.dismissConfirmError}
      />
      <FamilySettingsSectionHeader
        open={personalOpen}
        onToggle={() => setPersonalOpen(!personalOpen)}
        label="個人設定"
      />
      {personalOpen && (
        <FamilySettingsPersonalBlock
          displayNameState={displayNameState}
          userId={userId}
          syncArchived={syncArchived}
          onToggleSyncArchived={handleToggleSyncArchived}
          autoSyncInterval={autoSyncInterval}
          onAutoSyncIntervalChange={setAutoSyncInterval}
          iconSize={iconSize}
          onIconSizeChange={setIconSize}
        />
      )}
      <div className="moo-settings__divider" />
      <FamilySettingsSectionHeader
        open={familyOpen}
        onToggle={() => setFamilyOpen(!familyOpen)}
        label="家庭設定"
      />
      {familyOpen && (
        <>
          <FamilySettingsSyncCodeBlock
            syncCode={syncCode}
            copied={copied}
            inviteCopied={inviteCopied}
            onCopy={handleCopy}
            onInviteCopy={handleInviteCopy}
          />
          <FamilySettingsMembersBlock
            familyId={familyId}
            userId={userId}
            apiClient={apiClient}
            recentlyRemoved={recentlyRemoved}
            onMemberRemoved={setRecentlyRemoved}
            onDismissRemoved={() => setRecentlyRemoved(null)}
          />
        </>
      )}
      <FamilySettingsLeaveBlock
        familyId={familyId}
        userId={userId}
        apiClient={apiClient}
        onLeave={onLeave}
      />
      <div className="moo-settings__section-divider">
        <FamilySettingsSectionHeader
          open={mobileOpen}
          onToggle={() => setMobileOpen(!mobileOpen)}
          label="手機版登入"
        />
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
      <FamilySettingsDeleteBlock
        userId={userId}
        apiClient={apiClient}
        onLeave={onLeave}
      />
      <FamilySettingsReportLinks />
    </div>
  );
}
