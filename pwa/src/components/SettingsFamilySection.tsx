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
 * 設定頁「家庭設定」: the sync code with its share actions, and the member
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
  /**
   * The member removed most recently in THIS page session, kept only to offer
   * the "lift the rejoin block" entry (see `UnkickNotice`). Deliberately local:
   * leaving the page forgets it, and a second removal replaces the first.
   * Held here rather than inside `MemberList` so a failed member-list refresh —
   * which unmounts `MemberList` — cannot swallow the entry.
   */
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
