import type { ApiClient } from "@/api/client";
import { SettingsAboutSection } from "@/components/SettingsAboutSection";
import { SettingsDeleteAccountSection } from "@/components/SettingsDeleteAccountSection";
import { SettingsFamilySection } from "@/components/SettingsFamilySection";
import { SettingsLeaveFamilySection } from "@/components/SettingsLeaveFamilySection";
import { SettingsLogoutSection } from "@/components/SettingsLogoutSection";
import { SettingsPersonalSection } from "@/components/SettingsPersonalSection";

interface SettingsPageProps {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
  onLogout: () => void;
  onForceLogout: () => void;
}

/**
 * The settings tab. Every section is always rendered and owns its own state,
 * so a section's state lives exactly as long as the page does.
 */
export function SettingsPage({
  familyId,
  userId,
  apiClient,
  onLogout,
  onForceLogout,
}: SettingsPageProps) {
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold text-gray-900 mb-4">設定</h2>

      {/* Personal settings */}
      <SettingsPersonalSection
        familyId={familyId}
        userId={userId}
        apiClient={apiClient}
      />

      {/* Family settings */}
      <SettingsFamilySection
        familyId={familyId}
        userId={userId}
        apiClient={apiClient}
      />

      {/* Leave family */}
      <SettingsLeaveFamilySection
        familyId={familyId}
        userId={userId}
        apiClient={apiClient}
        onLogout={onLogout}
      />

      {/* Logout */}
      <SettingsLogoutSection onLogout={onLogout} />

      {/* Delete account */}
      <SettingsDeleteAccountSection
        userId={userId}
        apiClient={apiClient}
        onForceLogout={onForceLogout}
      />

      {/* About */}
      <SettingsAboutSection />
    </div>
  );
}
