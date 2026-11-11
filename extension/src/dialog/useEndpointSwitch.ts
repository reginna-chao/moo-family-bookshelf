// Gates adopting the family record's owner-controlled `apiEndpoint` behind explicit confirmation, in
// both directions; a refused confirm fails closed. A confirm checks storage's familyId before and
// after it writes. See docs/architecture.md → 端點切換確認.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  persistConfirmedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  saveDeclinedFamilyEndpoint,
  storedFamilyIdIs,
  type DeclinedFamilyEndpoint,
} from "../storage/familyEndpointChoice";
import {
  computePendingSwitch,
  type PendingEndpointSwitch,
} from "./pendingEndpointSwitch";
import type {
  UseEndpointSwitchOptions,
  UseEndpointSwitchResult,
} from "./endpointSwitchTypes";

export { computePendingSwitch, type PendingEndpointSwitch };
export type { UseEndpointSwitchOptions, UseEndpointSwitchResult };

export function useEndpointSwitch({
  apiClient,
  familyId,
  familyEndpoint,
  membersReady,
}: UseEndpointSwitchOptions): UseEndpointSwitchResult {
  const [pending, setPending] = useState<PendingEndpointSwitch | null>(null);
  const [declined, setDeclined] = useState<DeclinedFamilyEndpoint | null>(null);
  const [declinedLoaded, setDeclinedLoaded] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [confirmSaveFailed, setConfirmSaveFailed] = useState(false);
  const [confirmBindingGone, setConfirmBindingGone] = useState(false);
  // Where this device actually is. Seeded from the client (boot already applied any stored endpoint),
  // advanced by a confirm below, and rolled back when that confirm's save fails or finds the family binding gone.
  const [adoptedEndpoint, setAdoptedEndpoint] = useState<string>(() =>
    apiClient.getEndpoint(),
  );
  // Blocks a second confirm, and a decline, while a confirm is still reading or writing storage.
  const confirmingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      setConfirmBindingGone(false);
    }
  }, [apiClient, declined, declinedLoaded, familyEndpoint, membersReady]);

  const rememberDecline = useCallback((target: string | null) => {
    const marker: DeclinedFamilyEndpoint = { value: target };
    setDeclined(marker);
    setPending(null);
    void saveDeclinedFamilyEndpoint(marker);
  }, []);

  const decline = useCallback(() => {
    if (!pending || confirmingRef.current) return;
    rememberDecline(pending.target);
  }, [pending, rememberDecline]);

  // Never rejects. No `await` before the persist call: the client moves and drops its token before
  // this switch writes anything to storage.
  const applySwitch = useCallback(
    async (request: PendingEndpointSwitch): Promise<void> => {
      const previous = apiClient.getEndpoint();
      try {
        apiClient.setEndpoint(request.targetEndpoint);
      } catch (err) {
        // A malformed/unsafe value (a self-hosted record can hold anything): keep the endpoint, file it
        // as declined (no re-ask per refresh) and surface the failure, or the close reads as success.
        console.warn("[useEndpointSwitch] Family endpoint rejected", err);
        setConfirmError(true);
        rememberDecline(request.target);
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
      try {
        const result = await persistConfirmedFamilyEndpoint(
          request.target,
          familyId,
        );
        if (result === "bindingGone") {
          setConfirmBindingGone(true);
          setAdoptedEndpoint(previous);
        }
      } catch (err) {
        console.warn("[useEndpointSwitch] Could not store the switch", err);
        setConfirmSaveFailed(true);
        setAdoptedEndpoint(previous);
      }
    },
    [apiClient, familyId, rememberDecline],
  );

  const confirm = useCallback(() => {
    if (!pending || confirmingRef.current) return;
    const request = pending;
    confirmingRef.current = true;
    void (async () => {
      try {
        const bound = await storedFamilyIdIs(familyId);
        // Unmounted meanwhile (possibly this tab's own teardown): leave the client and storage alone.
        if (!mountedRef.current) return;
        if (!bound) {
          // Nothing written, no decline recorded: on a family-less device a decline would mute
          // the next family's question.
          setPending(null);
          setConfirmBindingGone(true);
          return;
        }
        await applySwitch(request);
      } finally {
        confirmingRef.current = false;
      }
    })();
  }, [applySwitch, familyId, pending]);

  const dismissConfirmError = useCallback(() => {
    setConfirmError(false);
    setConfirmSaveFailed(false);
    setConfirmBindingGone(false);
  }, []);

  return {
    pending,
    confirmError,
    confirmSaveFailed,
    confirmBindingGone,
    adoptedEndpoint,
    confirm,
    decline,
    dismissConfirmError,
  };
}
