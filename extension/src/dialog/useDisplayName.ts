import { useState, useEffect, useCallback, useRef } from "react";
import browser from "webextension-polyfill";
import { ApiClient } from "../api/client";
import { DISPLAY_NAME_KEY } from "../constants";
import { safeStorageGet } from "../storage/safeStorage";
import { rateLimitedEnvelopeMessage } from "./verificationMessages";
import { safeErrorText } from "moo-family-bookshelf-shared/api/safeErrorText";

type NameSaveState = "idle" | "saving" | "saved" | "error";

export interface UseDisplayNameOptions {
  apiClient?: ApiClient;
  familyId?: string;
  userId?: string;
  /** The server's display name (usually `useFamilyData().members`): when given it overrides
   *  chrome.storage.local. Pass `undefined` while loading to show the stored one optimistically. */
  initialDisplayName?: string;
}

export interface UseDisplayNameResult {
  displayName: string;
  savedDisplayName: string;
  nameSaveState: NameSaveState;
  nameSaveError: string;
  setDisplayName: (name: string) => void;
  handleSaveDisplayName: () => Promise<boolean>;
}

export function useDisplayName(
  options?: UseDisplayNameOptions,
): UseDisplayNameResult {
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState("");
  const [nameSaveState, setNameSaveState] = useState<NameSaveState>("idle");
  const [nameSaveError, setNameSaveError] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlightRef = useRef(false);
  // Tracks the current savedDisplayName for the prop-sync effect, without
  // forcing the effect to depend on it (which would cause re-runs on save).
  const savedDisplayNameRef = useRef("");

  useEffect(() => {
    savedDisplayNameRef.current = savedDisplayName;
  }, [savedDisplayName]);

  useEffect(() => {
    const initial = options?.initialDisplayName;

    if (typeof initial === "string") {
      // The server value wins: always update savedDisplayName, but displayName only when the user
      // is not editing (heuristic: it still tracks savedDisplayName).
      const prevSaved = savedDisplayNameRef.current;
      setSavedDisplayName(initial);
      setDisplayName((prev) => (prev === prevSaved ? initial : prev));
      return;
    }

    // While context loads, show chrome.storage.local's value optimistically; cancelled on unmount so
    // the deferred callback cannot setState on a dead component.
    let cancelled = false;
    void (async () => {
      const result = await safeStorageGet([DISPLAY_NAME_KEY]);
      if (cancelled) return;
      const cached = (result[DISPLAY_NAME_KEY] as string | undefined) ?? "";
      if (!cached) return;
      // Only initialize from cache when we haven't received any source value yet.
      if (savedDisplayNameRef.current !== "") return;
      setSavedDisplayName(cached);
      setDisplayName((prev) => (prev === "" ? cached : prev));
    })();

    return () => {
      cancelled = true;
    };
  }, [options?.initialDisplayName]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleSaveDisplayName = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false;
    // Cancel the pending saved→idle reset: firing mid-save would flip nameSaveState to "idle" and
    // drop the "saving" feedback.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    inFlightRef.current = true;

    const trimmed = displayName.trim();
    setNameSaveState("saving");
    setNameSaveError("");

    try {
      if (options?.apiClient && options.familyId && options.userId) {
        const response = await options.apiClient.updateDisplayName(
          options.familyId,
          options.userId,
          trimmed,
        );
        if (response.error) {
          // 429 shows the localized back-off copy instead of server English.
          setNameSaveError(
            rateLimitedEnvelopeMessage(response.error) ??
              safeErrorText(response.error.message, "儲存失敗，請稍後再試"),
          );
          setNameSaveState("error");
          return false;
        }
      }

      await browser.storage.local.set({ [DISPLAY_NAME_KEY]: trimmed });
      // Best-effort: storage.sync can reject in Firefox (no signed-in account, Android limits, pref
      // disabled), which must not read as a save failure after the local write.
      try {
        await browser.storage.sync.set({ [DISPLAY_NAME_KEY]: trimmed });
      } catch {
        // local persisted; sync is best-effort (may reject in Firefox)
        console.warn(
          "[useDisplayName] storage.sync.set failed; local write kept",
        );
      }
      setDisplayName(trimmed);
      setSavedDisplayName(trimmed);
      setNameSaveState("saved");
      // Clear before arming so a previous timer id is never overwritten
      // unclearable (the unmount cleanup only holds the latest id).
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setNameSaveState("idle"), 1500);
      return true;
    } catch (err) {
      setNameSaveError(err instanceof Error ? err.message : "儲存失敗");
      setNameSaveState("error");
      return false;
    } finally {
      inFlightRef.current = false;
    }
  }, [displayName, options?.apiClient, options?.familyId, options?.userId]);

  return {
    displayName,
    savedDisplayName,
    nameSaveState,
    nameSaveError,
    setDisplayName,
    handleSaveDisplayName,
  };
}
