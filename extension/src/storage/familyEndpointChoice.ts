/** Storage for the "switch to the family's API endpoint?" decision (confirmed switch / decline /
 *  reset), all via DIRECT storage access, never a background message. See docs/architecture.md →
 *  端點切換確認. */

import browser from "webextension-polyfill";
import {
  API_ENDPOINT_KEY,
  AUTH_TOKEN_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
  FAMILY_ID_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from "../constants";
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

/** The storage keys holding this device's family endpoint choice. The family teardowns put them
 *  in their own single storage removal (#492). */
export const FAMILY_ENDPOINT_CHOICE_KEYS: readonly string[] = [
  API_ENDPOINT_KEY,
  DECLINED_FAMILY_ENDPOINT_KEY,
];

/** `null` reverts to the official default: the key is removed rather than storing the default URL.
 *  Throws when storage refuses. */
async function writeAcceptedEndpoint(target: string | null): Promise<void> {
  if (target === null) {
    await browser.storage.local.remove([...FAMILY_ENDPOINT_CHOICE_KEYS]);
  } else {
    await browser.storage.local.set({ [API_ENDPOINT_KEY]: target });
    await browser.storage.local.remove([DECLINED_FAMILY_ENDPOINT_KEY]);
  }
}

/**
 * Persist the endpoint, swallowing storage failures so they cannot abort a
 * teardown: what resetFamilyEndpointChoice needs. `target` is a custom endpoint,
 * or `null` to revert to the official default.
 *
 * A confirmed switch and the sync-code join path adopt a server the stored token did not come from,
 * so they go through persistSwitchedFamilyEndpoint instead — the confirmed switch via
 * persistConfirmedFamilyEndpoint, which also checks the family binding.
 */
export async function persistAcceptedFamilyEndpoint(
  target: string | null,
): Promise<void> {
  try {
    await writeAcceptedEndpoint(target);
  } catch (err) {
    console.warn("[familyEndpointChoice] Failed to persist endpoint", err);
  }
}

/** Adopt an endpoint on another server: the token the old server issued is removed first.
 *  Rejects, with nothing written, when that removal fails; a failure at a later step rejects too.
 *
 *  The recovery cooldown goes with the token: it is the old server's 429, and would block the join
 *  on the new one. The last removal catches a token another tab's refresh wrote back before the
 *  endpoint write; once the endpoint is written that refresh no longer owns storage.
 *  Called directly by the sync-code join (no familyId is stored yet) and by the boot read; a
 *  confirmed switch reaches it through persistConfirmedFamilyEndpoint.
 *  See docs/architecture.md → 端點切換確認. */
export async function persistSwitchedFamilyEndpoint(
  target: string | null,
): Promise<void> {
  await browser.storage.local.remove([
    AUTH_TOKEN_KEY,
    TOKEN_EXPIRES_AT_KEY,
    RECOVERY_COOLDOWN_UNTIL_KEY,
  ]);
  await writeAcceptedEndpoint(target);
  await browser.storage.local.remove([AUTH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY]);
}

/** Whether storage still binds `familyId`. An unreadable store reads as `false`, so the caller
 *  refuses; only for the check before a confirmed switch writes anything. */
export async function storedFamilyIdIs(familyId: string): Promise<boolean> {
  const stored = await safeStorageGet([FAMILY_ID_KEY]);
  return stored[FAMILY_ID_KEY] === familyId;
}

/**
 * Persist a confirmed switch through persistSwitchedFamilyEndpoint, then re-read the binding.
 * Resolves `"switched"` when storage still binds `familyId`. Resolves `"bindingGone"` when it does
 * not: if storage still holds this write's endpoint and no token, the endpoint and the token keys
 * go in one removal, so a token is never left without its endpoint; otherwise another tab owns
 * storage (or, for `null`, nothing is left to undo) and nothing is written. Rejects when a write
 * or the re-read fails, with no removal. See docs/architecture.md → 端點切換確認.
 */
export async function persistConfirmedFamilyEndpoint(
  target: string | null,
  familyId: string,
): Promise<"switched" | "bindingGone"> {
  await persistSwitchedFamilyEndpoint(target);
  // Direct read, not safeStorageGet: a failed read must reject, never look like a lost binding.
  const stored = await browser.storage.local.get([
    FAMILY_ID_KEY,
    API_ENDPOINT_KEY,
    AUTH_TOKEN_KEY,
  ]);
  if (stored[FAMILY_ID_KEY] === familyId) return "switched";
  if (
    target !== null &&
    stored[API_ENDPOINT_KEY] === target &&
    stored[AUTH_TOKEN_KEY] === undefined
  ) {
    await browser.storage.local.remove([
      ...FAMILY_ENDPOINT_CHOICE_KEYS,
      AUTH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
    ]);
  }
  return "bindingGone";
}

/**
 * Drop this device's family-endpoint state entirely — the accepted endpoint AND
 * the declined marker — so a family-less client is back on the official default.
 *
 * Called only from dialog/useReauth.ts's catch path, after clearFamilyStorage rejects. The two
 * family teardowns (clearStoredFamilyBinding, clearFamilyStorage) instead fold
 * FAMILY_ENDPOINT_CHOICE_KEYS into their own single storage removal (#492).
 * The endpoint is a FAMILY-scoped setting: the owner picks it and every
 * member adopts it, so it must not outlive the membership. A client left pointing at a former
 * family's server would send the next create/join there — userId, display name, the auth token
 * that server issues, and the whole personal book list, unshared books included — and would bake
 * that host into the sync code it hands out next.
 * Clearing the declined marker matters for the same reason: a refusal recorded
 * against the old family must not silently suppress the confirmation prompt for
 * the next one.
 *
 * Delegates to persistAcceptedFamilyEndpoint(null): reverting to the default is
 * exactly the "remove both keys" write this needs, and a second copy of it here
 * would be one more place to drift.
 */
export async function resetFamilyEndpointChoice(): Promise<void> {
  await persistAcceptedFamilyEndpoint(null);
}
