import { useState, useEffect, useMemo, useRef } from "react";
import {
  buildSyncCodeInviteMessage,
  buildLinkInviteMessage,
} from "moo-family-bookshelf-shared/invite/messages";
import type { ApiClient } from "@/api/client";
import { encodeSyncCode } from "@/crypto/syncCode";
import { DEFAULT_API_ENDPOINT, buildInviteUrl } from "@/constants";

export interface SyncCodeShare {
  syncCode: string;
  copied: boolean;
  inviteCopied: boolean;
  handleCopy: () => Promise<void>;
  handleInvite: () => Promise<void>;
}

/**
 * The family sync code plus its two share actions (copy the code, send an
 * invite link) and their transient "已複製" confirmations. Called by the
 * always-mounted family section, so a confirmation survives collapsing it.
 */
export function useSyncCodeShare(
  familyId: string,
  apiClient: ApiClient,
): SyncCodeShare {
  const syncCode = useMemo(
    () =>
      encodeSyncCode({
        familyId,
        apiHost:
          apiClient.getEndpoint() !== DEFAULT_API_ENDPOINT
            ? apiClient.getEndpoint()
            : undefined,
      }),
    [familyId, apiClient],
  );
  const [copied, setCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inviteCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (inviteCopyTimerRef.current) clearTimeout(inviteCopyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildSyncCodeInviteMessage(syncCode));
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API failed — ignore silently on mobile
    }
  }

  async function handleInvite() {
    const inviteUrl = buildInviteUrl(syncCode);
    const message = buildLinkInviteMessage(inviteUrl);
    if (navigator.share) {
      try {
        // Pass `url` alongside the message so share targets can render a link
        // preview / "open in browser" affordance. The URL also appears inline
        // in `text` for targets that ignore the `url` field.
        await navigator.share({
          title: "加入墨家書櫃",
          text: message,
          url: inviteUrl,
        });
        return;
      } catch {
        // User cancelled or share failed — fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(message);
      setInviteCopied(true);
      inviteCopyTimerRef.current = setTimeout(
        () => setInviteCopied(false),
        2000,
      );
    } catch {
      // Clipboard API failed — ignore silently on mobile
    }
  }

  return { syncCode, copied, inviteCopied, handleCopy, handleInvite };
}
