import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { ApiClient } from "@/api/client";
import { SettingsDisplayNameField } from "@/components/SettingsDisplayNameField";
import { useAccountSyncArchived } from "@/hooks/useAccountSyncArchived";
import { useDisplayNameEditor } from "@/hooks/useDisplayNameEditor";
import {
  ACCOUNT_SETTINGS_SAVE_FAILED,
  SYNC_ARCHIVED_SHARED_NOTE,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";

const SYNC_ARCHIVED_HINT = `啟用後，個人書櫃會顯示已封存的書籍分頁，擴充功能同步時也會一併讀取封存的書。${SYNC_ARCHIVED_SHARED_NOTE}`;

interface SettingsPersonalSectionProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

/**
 * Settings-page 「個人設定」: display name and the 同步封存書籍 switch. Its state
 * lives here, not in the collapsible body, so collapsing keeps it.
 */
export function SettingsPersonalSection({
  familyId,
  userId,
  apiClient,
}: SettingsPersonalSectionProps) {
  const [personalOpen, setPersonalOpen] = useState(true);
  const syncArchived = useAccountSyncArchived(userId, apiClient);
  const editor = useDisplayNameEditor({ familyId, userId, apiClient });

  return (
    <section className="mb-6">
      <button
        onClick={() => setPersonalOpen(!personalOpen)}
        aria-expanded={personalOpen}
        className="flex items-center gap-1.5 text-sm font-medium text-gray-500 w-full"
      >
        {personalOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        個人設定
      </button>

      {personalOpen && (
        <div className="mt-3">
          <SettingsDisplayNameField editor={editor} userId={userId} />

          <SyncArchivedSwitch
            syncArchived={syncArchived.syncArchived}
            handleToggleSyncArchived={syncArchived.toggle}
          />
          <p className="text-gray-400 text-xs mt-1.5">{SYNC_ARCHIVED_HINT}</p>
          <SyncArchivedMessage message={syncArchived.message} />
        </div>
      )}
    </section>
  );
}

interface SyncArchivedMessageProps {
  message: string;
}

/** A failed save in red; the local-only notice as a plain hint. */
function SyncArchivedMessage({ message }: SyncArchivedMessageProps) {
  if (!message) return null;
  const tone =
    message === ACCOUNT_SETTINGS_SAVE_FAILED ? "text-red-600" : "text-gray-500";
  return <p className={`text-xs mt-1.5 ${tone}`}>{message}</p>;
}

interface SyncArchivedSwitchProps {
  syncArchived: BoolFlag;
  handleToggleSyncArchived: () => void;
}

function SyncArchivedSwitch({
  syncArchived,
  handleToggleSyncArchived,
}: SyncArchivedSwitchProps) {
  return (
    <button
      role="switch"
      aria-checked={syncArchived === BoolFlag.TRUE}
      aria-label="同步封存書籍"
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
      同步封存書籍
    </button>
  );
}
