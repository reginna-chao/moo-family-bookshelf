import { useState, useEffect, useRef } from "react";
import { buildInviteUrl } from "../constants";
import { useTimedFlag } from "../hooks/useTimedFlag";
import {
  buildSyncCodeInviteMessage,
  buildLinkInviteMessage,
} from "moo-family-bookshelf-shared/invite/messages";

export interface UseFamilySettingsCopyResult {
  copied: boolean;
  inviteCopied: boolean;
  linkCopied: boolean;
  handleCopy: () => Promise<void>;
  handleInviteCopy: () => Promise<void>;
  handleLinkCopy: () => Promise<void>;
}

/**
 * Clipboard copy of the sync-code message, the invite-link message and the
 * bare invite URL, each with a 2-second "copied" flag. Called by the
 * always-mounted `FamilySettings`, so the flags and their timers survive
 * collapsing the 家庭設定 section.
 */
export function useFamilySettingsCopy(
  syncCode: string | null,
): UseFamilySettingsCopyResult {
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inviteCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      if (inviteCopiedTimerRef.current !== null)
        clearTimeout(inviteCopiedTimerRef.current);
    };
  }, []);

  const [linkCopied, markLinkCopied] = useTimedFlag(2000);

  const handleCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(buildSyncCodeInviteMessage(syncCode));
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleInviteCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(
      buildLinkInviteMessage(buildInviteUrl(syncCode)),
    );
    setInviteCopied(true);
    if (inviteCopiedTimerRef.current !== null)
      clearTimeout(inviteCopiedTimerRef.current);
    inviteCopiedTimerRef.current = setTimeout(
      () => setInviteCopied(false),
      2000,
    );
  };

  // Only the URL, no message text — for pasting the link on its own.
  const handleLinkCopy = async () => {
    if (!syncCode) return;
    await navigator.clipboard.writeText(buildInviteUrl(syncCode));
    markLinkCopied();
  };

  return {
    copied,
    inviteCopied,
    linkCopied,
    handleCopy,
    handleInviteCopy,
    handleLinkCopy,
  };
}
