/**
 * useEndpointSwitch — gates adoption of the family record's `apiEndpoint`
 * behind an explicit user confirmation.
 *
 * The family owner controls that value and it is pushed to every member, so
 * adopting it silently hands the owner the ability to redirect another member's
 * auth token and full book list to an arbitrary host. Server-side URL filtering
 * is deliberately incomplete (worker/src/routes/family.ts) — this client-side
 * confirmation is its intended complement.
 *
 * BOTH directions are gated: adopting a custom endpoint, and reverting to the
 * official default. A refusal is remembered (storage/familyEndpointChoice.ts)
 * and only re-prompts once the family record moves to a different value.
 *
 * A confirmation the client's own URL validation then refuses is not silent:
 * the switch is abandoned, the value is filed as declined, and `confirmError`
 * drives a notice — otherwise the panel just closes and reads as success.
 */

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
  /**
   * False when the record's value fails the client's URL validation, i.e.
   * `confirm` is guaranteed to refuse it. The panel must not print such an
   * address as if it were a legitimate destination — see EndpointSwitchPanel.
   */
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
  /**
   * True when the last `confirm` was refused by the client's URL validation:
   * nothing was switched and the user has not been told yet.
   */
  confirmError: boolean;
  /**
   * The endpoint THIS device is actually using. The sync code / invite / QR must
   * be built from this — never from the family record's value — so a member who
   * declined a switch cannot redistribute the endpoint they refused.
   *
   * Surfaced as state because `apiClient.setEndpoint()` mutates without a React
   * re-render: initialized from the client, then updated the moment `confirm`
   * succeeds, so the sync code reflects a confirmed switch without a reopen.
   */
  adoptedEndpoint: string;
  /** Apply the switch and persist it. */
  confirm: () => void;
  /** Keep the current endpoint and remember the refusal. */
  decline: () => void;
  /** Acknowledge the refusal notice. */
  dismissConfirmError: () => void;
}

/**
 * Boundary guard for the family record's `apiEndpoint`: it is server data, so a
 * non-string or blank value means "the record carries no endpoint" (i.e. the
 * official-default direction), never a target to switch to.
 */
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

/**
 * Put the record's value in the same space as the client's own endpoint before
 * comparing (ApiClient stores what validateEndpointUrl returns), so a trailing
 * slash cannot make an identical endpoint look like a switch. A value the
 * validator refuses is kept verbatim and flagged `valid: false` — confirm's
 * try/catch still handles the failure; the flag is what stops the panel from
 * rendering the refused address as a legitimate destination.
 */
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
    // A fresh question supersedes a stale refusal notice. Only when there IS
    // one: the failed confirm files its target as declined, which re-runs this
    // effect with `next === null` — clearing unconditionally would wipe the
    // notice before the user ever sees it.
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
      // validateEndpointUrl throws on a malformed or unsafe URL, and a
      // self-hosted family record can hold anything. Nothing changed: keep the
      // current endpoint, file the value as declined so an unusable record
      // cannot re-open this panel on every members refresh, and surface the
      // failure — a silently closing panel reads as "switched successfully".
      console.warn("[useEndpointSwitch] Family endpoint rejected", err);
      setConfirmError(true);
      rememberDecline(pending.target);
      return;
    }
    setDeclined(null);
    setPending(null);
    // setEndpoint above already mutated the client; mirror its ACTUAL value —
    // not the requested one — so the sync code (built from adoptedEndpoint)
    // always shows what the client will really call, canonicalisation included.
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
