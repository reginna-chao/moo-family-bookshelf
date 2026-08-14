/**
 * Storage layer for the "switch to the family's API endpoint?" decision.
 *
 * The `apiEndpoint` stored on a family record is chosen by the family OWNER and
 * redistributed to every member. Adopting it silently would let an owner point
 * another member's client at a host of their choosing — which would receive
 * that member's Bearer token and full book list, unshared books included. The
 * Dialog therefore asks before switching (see dialog/useEndpointSwitch.ts) and
 * this module owns the storage access that decision needs — both directions of
 * API_ENDPOINT_KEY plus the declined marker:
 *
 * - ACCEPT writes API_ENDPOINT_KEY straight to storage.local (mirroring the
 *   background's handleSetApiEndpoint) and drops the declined marker. The
 *   direct write is what makes the choice stick in Firefox, whose sleeping
 *   background event page can drop the SET_API_ENDPOINT round-trip — the same
 *   reasoning as persistJoinCredentials in dialog/onboardingFlow.ts.
 * - DECLINE records the refused value so the user is asked again only once the
 *   family record moves to a DIFFERENT endpoint.
 * - READ hands the accepted endpoint back at dialog boot, again directly: the
 *   GET_API_ENDPOINT round-trip has the same Firefox failure mode as the write,
 *   where it would silently boot the dialog on the default endpoint.
 * - RESET drops both keys when the user leaves the family, because the endpoint
 *   is family-scoped and must not outlive the membership.
 */

import browser from "webextension-polyfill";
import { API_ENDPOINT_KEY, DECLINED_FAMILY_ENDPOINT_KEY } from "../constants";
import { safeStorageGet } from "./safeStorage";

/**
 * A refused endpoint switch. `value` is the target that was refused: a custom
 * endpoint URL, or `null` for the "revert to the official default" direction.
 */
export interface DeclinedFamilyEndpoint {
  value: string | null;
}

function parseDeclined(raw: unknown): DeclinedFamilyEndpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { value?: unknown }).value;
  if (value === null || typeof value === "string") return { value };
  return null;
}

/**
 * Read the recorded decline, or `null` when there is none.
 *
 * Best-effort: an unreadable store degrades to `null`, i.e. "nothing declined",
 * which makes the prompt appear again. That is the safe direction — the failure
 * mode is one extra confirmation, never an unconfirmed endpoint switch.
 */
export async function readDeclinedFamilyEndpoint(): Promise<DeclinedFamilyEndpoint | null> {
  const result = await safeStorageGet([DECLINED_FAMILY_ENDPOINT_KEY]);
  return parseDeclined(result[DECLINED_FAMILY_ENDPOINT_KEY]);
}

/**
 * Read the API endpoint this device has accepted, or `null` when there is none
 * (i.e. the official default is in effect).
 *
 * Best-effort like readDeclinedFamilyEndpoint: an unreadable store degrades to
 * `null`, which falls back to the default endpoint rather than throwing.
 *
 * URL validation is deliberately NOT done here — ApiClient.setEndpoint owns it,
 * and duplicating the rules in storage would let the two drift. A non-string or
 * blank stored value is "nothing stored".
 */
export async function readStoredApiEndpoint(): Promise<string | null> {
  const result = await safeStorageGet([API_ENDPOINT_KEY]);
  const stored = result[API_ENDPOINT_KEY];
  if (typeof stored !== "string") return null;
  const trimmed = stored.trim();
  return trimmed === "" ? null : trimmed;
}

/** Record a refused endpoint switch so the same value stops re-prompting. */
export async function saveDeclinedFamilyEndpoint(
  declined: DeclinedFamilyEndpoint,
): Promise<void> {
  try {
    await browser.storage.local.set({
      [DECLINED_FAMILY_ENDPOINT_KEY]: declined,
    });
  } catch (err) {
    console.warn(
      "[familyEndpointChoice] Failed to record declined endpoint",
      err,
    );
  }
}

/**
 * Persist an ACCEPTED endpoint switch. `target` is the family record's custom
 * endpoint, or `null` to revert to the official default (which removes the key
 * rather than storing the default URL — mirrors handleSetApiEndpoint).
 *
 * The direct storage write is authoritative; the background message that
 * follows is a best-effort secondary so the change also travels the path the
 * rest of the extension uses. A background failure (asleep, or its stricter
 * HTTP-host validation rejecting a LAN endpoint the ApiClient allows) leaves
 * the already-written local value intact.
 *
 * Also used by the sync-code join path (dialog/onboardingFlow.ts): pasting a
 * code that carries an `@host` is an explicit acceptance of that endpoint, so
 * it persists identically — declined marker cleared included.
 */
export async function persistAcceptedFamilyEndpoint(
  target: string | null,
): Promise<void> {
  try {
    if (target === null) {
      await browser.storage.local.remove([
        API_ENDPOINT_KEY,
        DECLINED_FAMILY_ENDPOINT_KEY,
      ]);
    } else {
      await browser.storage.local.set({ [API_ENDPOINT_KEY]: target });
      await browser.storage.local.remove([DECLINED_FAMILY_ENDPOINT_KEY]);
    }
  } catch (err) {
    console.warn("[familyEndpointChoice] Failed to persist endpoint", err);
  }

  try {
    await browser.runtime.sendMessage({
      type: "SET_API_ENDPOINT",
      apiEndpoint: target,
    });
  } catch {
    // Background unavailable — the direct write above already persisted.
  }
}

/**
 * Drop this device's family-endpoint state entirely — the accepted endpoint AND
 * the declined marker — so a family-less client is back on the official default.
 *
 * Called when the user leaves a family (dialog/App.tsx). The endpoint is a
 * FAMILY-scoped setting: the owner picks it and every member adopts it, so it
 * must not outlive the membership. A client left pointing at a former family's
 * server would send the next create/join there — userId, display name, the auth
 * token that server issues, and the whole personal book list, unshared books
 * included — and would bake that host into the sync code it hands out next.
 * Clearing the declined marker matters for the same reason: a refusal recorded
 * against the old family must not silently suppress the confirmation prompt for
 * the next one.
 *
 * Delegates to persistAcceptedFamilyEndpoint(null): reverting to the default is
 * exactly the "remove both keys, then tell the background" write this needs, and
 * a second copy of it here would be one more place to drift.
 */
export async function resetFamilyEndpointChoice(): Promise<void> {
  await persistAcceptedFamilyEndpoint(null);
}
