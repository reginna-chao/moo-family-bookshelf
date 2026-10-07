import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ApiClient } from "@/api/client";
import type { RemovedMemberInfo } from "@/components/MemberList";
import { SettingsFamilyMembers } from "@/components/SettingsFamilyMembers";
import { SettingsSyncCodeShare } from "@/components/SettingsSyncCodeShare";
import { useSyncCodeShare } from "@/hooks/useSyncCodeShare";

interface SettingsFamilySectionProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

/**
 * Settings-page 「家庭設定」: the sync code with its share actions, and the member
 * list. Its state lives here, not in the collapsible body, so collapsing
 * keeps it.
 */
export function SettingsFamilySection({
  familyId,
  userId,
  apiClient,
}: SettingsFamilySectionProps) {
  const [familyOpen, setFamilyOpen] = useState(true);
  const share = useSyncCodeShare(familyId, apiClient);
  /** Latest removal this page session, for the `UnkickNotice` entry (leaving forgets it; a second
   *  replaces it). Held here: a failed list refresh unmounts `MemberList` and would swallow it. */
  const [recentlyRemoved, setRecentlyRemoved] =
    useState<RemovedMemberInfo | null>(null);

  return (
    <section className="mb-6 pt-6 border-t border-gray-200">
      <button
        onClick={() => setFamilyOpen(!familyOpen)}
        aria-expanded={familyOpen}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-500 w-full"
      >
        {familyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        家庭設定
      </button>

      {familyOpen && (
        <div className="mt-3">
          <SettingsSyncCodeShare share={share} />
          <SettingsFamilyMembers
            familyId={familyId}
            userId={userId}
            apiClient={apiClient}
            recentlyRemoved={recentlyRemoved}
            setRecentlyRemoved={setRecentlyRemoved}
          />
        </div>
      )}
    </section>
  );
}
