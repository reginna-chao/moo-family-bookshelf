import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { BoolFlag } from "@/api/client";
import type { ApiClient } from "@/api/client";
import { SettingsDisplayNameField } from "@/components/SettingsDisplayNameField";
import { namespacedKey } from "@/hooks/useAuth";
import { useDisplayNameEditor } from "@/hooks/useDisplayNameEditor";

interface SettingsPersonalSectionProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

/**
 * Settings-page 「個人設定」: display name and the show-archived switch. Its state
 * lives here, not in the collapsible body, so collapsing keeps it.
 */
export function SettingsPersonalSection({
  familyId,
  userId,
  apiClient,
}: SettingsPersonalSectionProps) {
  const [personalOpen, setPersonalOpen] = useState(true);

  // --- Sync archived setting ---
  const syncArchivedKey = namespacedKey(userId, "syncArchived");
  const [syncArchived, setSyncArchived] = useState<BoolFlag>(() => {
    const stored = localStorage.getItem(syncArchivedKey);
    return stored === "1" ? BoolFlag.TRUE : BoolFlag.FALSE;
  });

  const handleToggleSyncArchived = useCallback(() => {
    setSyncArchived((prev) => {
      const next = prev === BoolFlag.TRUE ? BoolFlag.FALSE : BoolFlag.TRUE;
      localStorage.setItem(syncArchivedKey, String(next));
      return next;
    });
  }, [syncArchivedKey]);

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
            syncArchived={syncArchived}
            handleToggleSyncArchived={handleToggleSyncArchived}
          />
          <p className="text-gray-400 text-xs mt-1.5">
            啟用後，個人書櫃會顯示已封存的書籍分頁
          </p>
        </div>
      )}
    </section>
  );
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
  );
}
