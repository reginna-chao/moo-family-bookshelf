import { useState, useEffect, useCallback, useRef } from "react";
import { ApiClient } from "../api/client";
import { DISPLAY_NAME_KEY } from "../constants";

type NameSaveState = "idle" | "saving" | "saved" | "error";

export interface UseDisplayNameOptions {
  apiClient?: ApiClient;
  familyId?: string;
  userId?: string;
  /**
   * Authoritative display name from the server (typically sourced from
   * `useFamilyData().members`). When provided, this is the source of truth —
   * it overrides chrome.storage.local and is preferred on re-renders.
   *
   * Pass `undefined` while still loading; the hook falls back to
   * chrome.storage.local for an optimistic display.
   */
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

export function useDisplayName(options?: UseDisplayNameOptions): UseDisplayNameResult {
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
      // Server value (from FamilyDataContext) is the source of truth.
      // Update savedDisplayName always; only update displayName when the user
      // is NOT editing (heuristic: displayName still tracks savedDisplayName).
      const prevSaved = savedDisplayNameRef.current;
      setSavedDisplayName(initial);
      setDisplayName((prev) => (prev === prevSaved ? initial : prev));
      return;
    }

    // Fallback: read chrome.storage.local for an optimistic display while
    // context is still loading. Cancel on unmount so the deferred callback
    // can't setState on a dead component.
    let cancelled = false;
    chrome.storage.local.get([DISPLAY_NAME_KEY], (result) => {
      if (cancelled) return;
      const cached = (result[DISPLAY_NAME_KEY] as string | undefined) ?? "";
      if (!cached) return;
      // Only initialize from cache when we haven't received any source value yet.
      if (savedDisplayNameRef.current !== "") return;
      setSavedDisplayName(cached);
      setDisplayName((prev) => (prev === "" ? cached : prev));
    });

    return () => { cancelled = true; };
  }, [options?.initialDisplayName]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleSaveDisplayName = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return false;
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
          setNameSaveError(response.error.message);
          setNameSaveState("error");
          return false;
        }
      }

      await chrome.storage.local.set({ [DISPLAY_NAME_KEY]: trimmed });
      await chrome.storage.sync.set({ [DISPLAY_NAME_KEY]: trimmed });
      setDisplayName(trimmed);
      setSavedDisplayName(trimmed);
      setNameSaveState("saved");
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
