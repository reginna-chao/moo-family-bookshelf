import { useState, useEffect, useCallback } from "react";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";
import type { ApiClient } from "@/api/client";
import { useFamilyData } from "@/hooks/useFamilyData";
import { rateLimitedEnvelopeMessage } from "@/utils/retryMessage";

interface UseDisplayNameEditorOptions {
  familyId: string;
  userId: string;
  apiClient: ApiClient;
}

export interface DisplayNameEditor {
  editingName: boolean;
  setEditingName: (editing: boolean) => void;
  nameInput: string;
  setNameInput: (value: string) => void;
  currentName: string;
  nameSaving: boolean;
  nameError: string | null;
  setNameError: (error: string | null) => void;
  handleSaveName: () => Promise<void>;
}

/**
 * The caller's own display-name editor: the name shown (kept in step with the
 * family member list), the inline edit state, and the save. Called by the
 * always-mounted personal section, so an edit in progress survives collapsing
 * it.
 */
export function useDisplayNameEditor({
  familyId,
  userId,
  apiClient,
}: UseDisplayNameEditorOptions): DisplayNameEditor {
  const {
    members,
    refreshMembers: loadMembers,
    updateMemberDisplayName,
  } = useFamilyData();
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [currentName, setCurrentName] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    const self = members.find((m) => m.userId === userId);
    if (self) {
      setCurrentName(self.displayName || "");
    }
  }, [members, userId]);

  const handleSaveName = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed || trimmed === currentName) {
      setEditingName(false);
      return;
    }
    setNameSaving(true);
    setNameError(null);
    try {
      const res = await apiClient.updateDisplayName(familyId, userId, trimmed);
      if (res.error) {
        // 429 shows the localized back-off copy instead of server English.
        setNameError(
          rateLimitedEnvelopeMessage(res.error) ??
            safeErrorText(res.error.message, "更新失敗，請稍後再試"),
        );
        setNameSaving(false);
        return;
      }
      setCurrentName(trimmed);
      setEditingName(false);
      // Reflect the new name in the family shelf / members list immediately
      updateMemberDisplayName(userId, trimmed);
      void loadMembers();
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "更新失敗");
    } finally {
      setNameSaving(false);
    }
  }, [
    nameInput,
    currentName,
    apiClient,
    familyId,
    userId,
    loadMembers,
    updateMemberDisplayName,
  ]);

  return {
    editingName,
    setEditingName,
    nameInput,
    setNameInput,
    currentName,
    nameSaving,
    nameError,
    setNameError,
    handleSaveName,
  };
}
