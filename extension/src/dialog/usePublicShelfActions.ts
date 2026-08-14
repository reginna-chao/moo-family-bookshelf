import { useCallback, useEffect, useRef, useState } from "react";
import {
  divergentFields,
  hasDivergentFields,
  reconcileTitle,
  type PublicShelfUpdate,
} from "moo-family-bookshelf-shared/publicShelf/diff";
import type { ApiClient } from "../api/client";
import type { PublicShelf } from "../api/types";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import {
  BLANK_TITLE_MESSAGE,
  publicShelfErrorMessage,
  publicShelfSaveErrorMessage,
} from "./publicShareMessages";

export type PublicShelfViewState = "loading" | "empty" | "active" | "error";

/** Debounce window for the title input's write-through. */
const TITLE_SYNC_DELAY_MS = 1000;

/** Expiry preselected before a shelf exists. */
const DEFAULT_EXPIRES_DAYS = 30;

export interface UsePublicShelfActionsParams {
  userId: string;
  apiClient: ApiClient;
  defaultDisplayName: string;
}

export interface PublicShelfActions {
  viewState: PublicShelfViewState;
  shelf: PublicShelf | null;
  title: string;
  expiresDays: number | null;
  errorMsg: string;
  saving: boolean;
  /** An edit that never reached the server, with nothing queued or in flight. */
  hasUnsavedChanges: boolean;
  setTitle: (value: string) => void;
  setExpiresDays: (value: number | null) => void;
  handleCreate: () => Promise<void>;
  handleTitleChange: (value: string) => void;
  handleExpiresDaysChange: (value: number | null) => Promise<void>;
  handleResetToken: () => Promise<void>;
  handleDelete: () => Promise<void>;
  handleRetrySave: () => Promise<void>;
}

/**
 * Public-shelf state plus every write the dialog can perform.
 *
 * Failure policy: a rejected write NEVER advances the UI past what the server
 * confirmed. A failed delete keeps the active shelf on screen (the public link
 * is still live), and a failed title/expiry write keeps the user's value but
 * reports it as unsaved instead of pretending it synced.
 */
export function usePublicShelfActions({
  userId,
  apiClient,
  defaultDisplayName,
}: UsePublicShelfActionsParams): PublicShelfActions {
  const [viewState, setViewState] = useState<PublicShelfViewState>("loading");
  const [shelf, setShelf] = useState<PublicShelf | null>(null);
  const [title, setTitle] = useState("");
  const [expiresDays, setExpiresDays] = useState<number | null>(
    DEFAULT_EXPIRES_DAYS,
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [saving, setSaving] = useState(false);
  /** A title edit is waiting out the debounce window. */
  const [titleQueued, setTitleQueued] = useState(false);
  /** Title/expiry writes currently on the wire. */
  const [inFlight, setInFlight] = useState(0);
  // Queue and wire are independent: one boolean cannot represent both, and
  // clearing it at the end of an expiry write used to mark a still-queued title
  // edit as unsaved (and invite a duplicate PUT via 重試儲存).
  const syncPending = titleQueued || inFlight > 0;

  /** shelfId the UI is bound to right now; null once the shelf is revoked. */
  const activeShelfIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeShelfIdRef.current = shelf?.shelfId ?? null;
  }, [shelf]);
  /** Issue order of the writes — only the newest may publish its response. */
  const writeSeqRef = useRef(0);

  const loadShelves = useCallback(async () => {
    setViewState("loading");
    try {
      const { shelves } = await apiClient.listPublicShelves(userId);
      if (shelves.length > 0) {
        setShelf(shelves[0]);
        setTitle(shelves[0].title);
        setExpiresDays(shelves[0].expiresDays);
        setViewState("active");
        return;
      }
      setTitle(`${defaultDisplayName} 的公開書櫃`);
      setViewState("empty");
    } catch (e) {
      setErrorMsg(publicShelfErrorMessage(e, "載入失敗"));
      setViewState("error");
    }
  }, [userId, apiClient, defaultDisplayName]);

  useEffect(() => {
    void loadShelves();
  }, [loadShelves]);

  /** Single writer for the title / expiry / retry paths. */
  const runUpdate = useCallback(
    async (shelfId: string, body: PublicShelfUpdate): Promise<void> => {
      // The shelf was revoked while this write sat in the debounce queue: the
      // shelfId no longer exists, so firing it would only paint a red
      // SHELF_NOT_FOUND right after a confirmed revocation. Reset-token keeps
      // the shelfId, so a legitimate queued title write still goes through.
      if (activeShelfIdRef.current !== shelfId) {
        setTitleQueued(false);
        return;
      }
      // A blank title is rejected server-side and would still spend one unit of
      // the per-userId write ceiling, so it never leaves the client.
      if (body.title !== undefined && body.title.trim() === "") {
        setTitleQueued(false);
        setErrorMsg(BLANK_TITLE_MESSAGE);
        return;
      }
      const seq = ++writeSeqRef.current;
      setInFlight((count) => count + 1);
      try {
        const { shelf: updated } = await apiClient.updatePublicShelf(
          userId,
          shelfId,
          body,
        );
        // Superseded by a later write, or the shelf is gone: the response is
        // stale, and publishing it would roll the UI back.
        const stale =
          seq !== writeSeqRef.current || activeShelfIdRef.current !== shelfId;
        if (stale) return;
        setShelf(updated);
        setTitle((current) =>
          reconcileTitle(current, body.title, updated.title),
        );
        setErrorMsg("");
      } catch (e) {
        // Same reasoning as the pre-flight guard: a write whose shelf was
        // revoked mid-flight has no field left to reconcile, and the user just
        // confirmed the revocation. A write merely SUPERSEDED by a later one
        // still reports — its own field may remain diverged.
        if (activeShelfIdRef.current !== shelfId) return;
        setErrorMsg(publicShelfSaveErrorMessage(e));
      } finally {
        setInFlight((count) => count - 1);
      }
    },
    [userId, apiClient],
  );

  const syncTitle = useDebouncedCallback(
    (shelfId: string, newTitle: string) => {
      // Queued → in flight with no gap: `runUpdate` raises `inFlight` before it
      // yields, so `syncPending` never dips false between the two.
      setTitleQueued(false);
      // Late writer: the shelf may have been revoked during the debounce.
      if (!shelf || shelf.shelfId !== shelfId) return;
      // Expiry is pinned to the server value on purpose — this path may only
      // carry the title, and echoing expiresDays would extend the lifetime.
      const body = divergentFields(shelf, newTitle, shelf.expiresDays);
      // Already what the server holds: spending a write here buys nothing.
      if (body.title === undefined) return;
      void runUpdate(shelfId, body);
    },
    TITLE_SYNC_DELAY_MS,
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      setTitle(newTitle);
      if (!shelf) return;
      // Queued, not diverged — keep the unsaved notice quiet while typing.
      setTitleQueued(true);
      syncTitle(shelf.shelfId, newTitle);
    },
    [shelf, syncTitle],
  );

  const handleExpiresDaysChange = useCallback(
    async (value: number | null) => {
      setExpiresDays(value);
      if (!shelf) return;
      // Title pinned to the server value: this path carries expiry alone.
      const body = divergentFields(shelf, shelf.title, value);
      if (body.expiresDays === undefined) return;
      await runUpdate(shelf.shelfId, body);
    },
    [shelf, runUpdate],
  );

  const handleRetrySave = useCallback(async () => {
    if (!shelf) return;
    const body = divergentFields(shelf, title, expiresDays);
    if (Object.keys(body).length === 0) return;
    await runUpdate(shelf.shelfId, body);
  }, [shelf, title, expiresDays, runUpdate]);

  const handleCreate = useCallback(async () => {
    setSaving(true);
    setErrorMsg("");
    try {
      const { shelf: created } = await apiClient.createPublicShelf(userId, {
        title,
        expiresDays,
      });
      setShelf(created);
      setTitle(created.title);
      setExpiresDays(created.expiresDays);
      setViewState("active");
    } catch (e) {
      setErrorMsg(publicShelfErrorMessage(e, "建立失敗"));
    } finally {
      setSaving(false);
    }
  }, [userId, apiClient, title, expiresDays]);

  const handleResetToken = useCallback(async () => {
    if (!shelf) return;
    setSaving(true);
    try {
      const { shelf: updated } = await apiClient.resetPublicShelfToken(
        userId,
        shelf.shelfId,
      );
      setShelf(updated);
      setErrorMsg("");
    } catch (e) {
      setErrorMsg(publicShelfErrorMessage(e, "重設失敗"));
    } finally {
      setSaving(false);
    }
  }, [userId, apiClient, shelf]);

  const handleDelete = useCallback(async () => {
    if (!shelf) return;
    setSaving(true);
    try {
      await apiClient.deletePublicShelf(userId, shelf.shelfId);
      // Reached only when the server confirmed the revocation.
      setShelf(null);
      setTitle(`${defaultDisplayName} 的公開書櫃`);
      setExpiresDays(DEFAULT_EXPIRES_DAYS);
      setErrorMsg("");
      setViewState("empty");
    } catch (e) {
      // The snapshot is still being served — keep the shelf on screen.
      setErrorMsg(publicShelfErrorMessage(e, "關閉失敗"));
    } finally {
      setSaving(false);
    }
  }, [userId, apiClient, shelf, defaultDisplayName]);

  return {
    viewState,
    shelf,
    title,
    expiresDays,
    errorMsg,
    saving,
    hasUnsavedChanges:
      !syncPending && hasDivergentFields(shelf, title, expiresDays),
    setTitle,
    setExpiresDays,
    handleCreate,
    handleTitleChange,
    handleExpiresDaysChange,
    handleResetToken,
    handleDelete,
    handleRetrySave,
  };
}
