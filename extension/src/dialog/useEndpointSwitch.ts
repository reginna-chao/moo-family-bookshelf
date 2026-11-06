// Gates adopting the family record's owner-controlled `apiEndpoint` behind explicit confirmation, in
// both directions; a refused confirm fails closed. See docs/architecture.md → 端點切換確認.

import { useCallback, useEffect, useState } from "react";
import type { ApiClient } from "../api/client";
import {
  persistSwitchedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  saveDeclinedFamilyEndpoint,
  type DeclinedFamilyEndpoint,
} from "../storage/familyEndpointChoice";
import {
  computePendingSwitch,
  type PendingEndpointSwitch,
} from "./pendingEndpointSwitch";

export { computePendingSwitch, type PendingEndpointSwitch };

export interface UseEndpointSwitchOptions {
  apiClient: ApiClient;
  /** `apiEndpoint` from the family record; `undefined` = record has none. */
  familyEndpoint: string | undefined;
  /** True once the members request carrying `familyEndpoint` has resolved. */
  membersReady: boolean;
}

export interface UseEndpointSwitchResult {
  /** The switch awaiting a decision, or `null` when there is nothing to ask. */
  pending: PendingEndpointSwitch | null;
  /** True when the last `confirm` was refused by the client's URL validation: nothing switched, and
   *  the user has not been told yet. */
  confirmError: boolean;
  /** True when the last `confirm` switched the client but storage did not take all of it. First
   *  removal or endpoint write failed: a reload returns to the old server and asks again. A later
   *  step failed: the reload stays on the new server and does not ask again. */
  confirmSaveFailed: boolean;
  /** The endpoint THIS device uses; sync code / invite / QR come from it, never the record. State, as
   *  setEndpoint() does not re-render. See docs/architecture.md → 端點切換確認. */
  adoptedEndpoint: string;
  /** Apply the switch and persist it. */
  confirm: () => void;
  /** Keep the current endpoint and remember the refusal. */
  decline: () => void;
  /** Acknowledge the refusal or save-failure notice. */
  dismissConfirmError: () => void;
}

export function useEndpointSwitch({
  apiClient,
  familyEndpoint,
  membersReady,
}: UseEndpointSwitchOptions): UseEndpointSwitchResult {
  const [pending, setPending] = useState<PendingEndpointSwitch | null>(null);
  const [declined, setDeclined] = useState<DeclinedFamilyEndpoint | null>(null);
  const [declinedLoaded, setDeclinedLoaded] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [confirmSaveFailed, setConfirmSaveFailed] = useState(false);
  // Where this device actually is. Seeded from the client (boot already applied any stored
  // endpoint), advanced by a confirm below, and rolled back when that confirm's save fails.
  const [adoptedEndpoint, setAdoptedEndpoint] = useState<string>(() =>
    apiClient.getEndpoint(),
  );

  // One read per mount. Nothing is asked before it resolves, so a previously
  // declined value never flashes the panel on its way to being suppressed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readDeclinedFamilyEndpoint();
      if (cancelled) return;
      setDeclined(stored);
      setDeclinedLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!membersReady || !declinedLoaded) return;
    const next = computePendingSwitch({
      current: apiClient.getEndpoint(),
      familyEndpoint,
      declined,
    });
    setPending(next);
    // Only a fresh question clears a stale refusal notice: a failed confirm's decline re-runs this
    // with `next === null`, and clearing then would wipe the notice unseen.
    if (next) {
      setConfirmError(false);
      setConfirmSaveFailed(false);
    }
  }, [apiClient, declined, declinedLoaded, familyEndpoint, membersReady]);

  const rememberDecline = useCallback((target: string | null) => {
    const marker: DeclinedFamilyEndpoint = { value: target };
    setDeclined(marker);
    setPending(null);
    void saveDeclinedFamilyEndpoint(marker);
  }, []);

  const decline = useCallback(() => {
    if (!pending) return;
    rememberDecline(pending.target);
  }, [pending, rememberDecline]);

  const confirm = useCallback(() => {
    if (!pending) return;
    const previous = apiClient.getEndpoint();
    try {
      apiClient.setEndpoint(pending.targetEndpoint);
    } catch (err) {
      // A malformed/unsafe value (a self-hosted record can hold anything): keep the endpoint, file it
      // as declined (no re-ask per refresh) and surface the failure, or the close reads as success.
      console.warn("[useEndpointSwitch] Family endpoint rejected", err);
      setConfirmError(true);
      rememberDecline(pending.target);
      return;
    }
    // The old server's token goes nowhere: dropped here, and the new server's join issues its own.
    apiClient.setAuthToken(null);
    setDeclined(null);
    setPending(null);
    // Mirror the client's ACTUAL value (canonicalised), not the requested one, so the sync code
    // shows what the client will really call.
    setAdoptedEndpoint(apiClient.getEndpoint());
    // React state only on failure: a teardown may already have moved the client, so it stays put.
    void persistSwitchedFamilyEndpoint(pending.target).catch((err) => {
      console.warn("[useEndpointSwitch] Could not store the switch", err);
      setConfirmSaveFailed(true);
      setAdoptedEndpoint(previous);
    });
  }, [apiClient, pending, rememberDecline]);

  const dismissConfirmError = useCallback(() => {
    setConfirmError(false);
    setConfirmSaveFailed(false);
  }, []);

  return {
    pending,
    confirmError,
    confirmSaveFailed,
    adoptedEndpoint,
    confirm,
    decline,
    dismissConfirmError,
  };
}
