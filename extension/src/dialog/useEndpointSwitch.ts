// Gates adopting the family record's owner-controlled `apiEndpoint` behind explicit confirmation, in
// both directions; a refused confirm fails closed. See docs/architecture.md → 端點切換確認.

import { useCallback, useEffect, useState } from "react";
import { ApiClient, validateEndpointUrl } from "../api/client";
import { DEFAULT_API_ENDPOINT } from "../constants";
import {
  persistAcceptedFamilyEndpoint,
  readDeclinedFamilyEndpoint,
  saveDeclinedFamilyEndpoint,
  type DeclinedFamilyEndpoint,
} from "../storage/familyEndpointChoice";

export interface PendingEndpointSwitch {
  /** Endpoint the ApiClient is using right now. */
  current: string;
  /** Canonicalised target from the family record; `null` = the official default. */
  target: string | null;
  /** Resolved target URL (DEFAULT_API_ENDPOINT when `target` is `null`). */
  targetEndpoint: string;
  /** True when the switch reverts to the official default endpoint. */
  isDefaultTarget: boolean;
  /** False when the record's value fails the client's URL validation (`confirm` will refuse it); the
   *  panel must not print it as a legitimate destination. */
  targetValid: boolean;
}

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
  /** The endpoint THIS device uses; sync code / invite / QR come from it, never the record. State, as
   *  setEndpoint() does not re-render. See docs/architecture.md → 端點切換確認. */
  adoptedEndpoint: string;
  /** Apply the switch and persist it. */
  confirm: () => void;
  /** Keep the current endpoint and remember the refusal. */
  decline: () => void;
  /** Acknowledge the refusal notice. */
  dismissConfirmError: () => void;
}

/** Boundary guard: a non-string or blank record value means "no endpoint" (the official-default
 *  direction), never a target to switch to. */
function normalizeFamilyEndpoint(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** A record endpoint put in the client's comparison space, plus its verdict. */
interface CanonicalTarget {
  value: string | null;
  valid: boolean;
}

/** Canonicalize the record's value like the client's endpoint (no trailing-slash false switch); a
 *  refused value stays verbatim with `valid: false`, which keeps the panel from printing it. */
function canonicalizeTarget(raw: string | null): CanonicalTarget {
  if (raw === null) return { value: null, valid: true };
  try {
    return { value: validateEndpointUrl(raw), valid: true };
  } catch {
    return { value: raw, valid: false };
  }
}

/**
 * Pure: decide whether the family record asks for an endpoint the user has not
 * yet agreed to. Returns `null` when the target is already in effect, or when
 * this exact target was previously declined.
 *
 * The returned `target` is canonical, so it is also what confirm/decline
 * persist — matching what the sync-code join path stores for the same endpoint.
 */
export function computePendingSwitch(params: {
  current: string;
  familyEndpoint: string | undefined;
  declined: DeclinedFamilyEndpoint | null;
}): PendingEndpointSwitch | null {
  const { value: target, valid: targetValid } = canonicalizeTarget(
    normalizeFamilyEndpoint(params.familyEndpoint),
  );
  const targetEndpoint = target ?? DEFAULT_API_ENDPOINT;
  if (targetEndpoint === params.current) return null;
  if (params.declined && params.declined.value === target) return null;
  return {
    current: params.current,
    target,
    targetEndpoint,
    isDefaultTarget: target === null,
    targetValid,
  };
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
  // Where this device actually is. Seeded from the client (boot already applied
  // any stored endpoint) and advanced only by a successful confirm below.
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
    if (next) setConfirmError(false);
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
    setDeclined(null);
    setPending(null);
    // Mirror the client's ACTUAL value (canonicalised), not the requested one, so the sync code
    // shows what the client will really call.
    setAdoptedEndpoint(apiClient.getEndpoint());
    void persistAcceptedFamilyEndpoint(pending.target);
  }, [apiClient, pending, rememberDecline]);

  const dismissConfirmError = useCallback(() => setConfirmError(false), []);

  return {
    pending,
    confirmError,
    adoptedEndpoint,
    confirm,
    decline,
    dismissConfirmError,
  };
}
