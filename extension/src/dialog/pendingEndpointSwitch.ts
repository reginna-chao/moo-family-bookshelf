// Pure decision: does the family record ask for an endpoint this device has not agreed to? See
// docs/architecture.md → 端點切換確認.

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";
import { DEFAULT_API_ENDPOINT } from "../constants";
import type { DeclinedFamilyEndpoint } from "../storage/familyEndpointChoice";

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
