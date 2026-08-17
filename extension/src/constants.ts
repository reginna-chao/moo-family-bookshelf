/**
 * Shared constants for the extension.
 * Centralised so that values like the API endpoint only need
 * to be changed in one place.
 *
 * VITE_EXTENSION_API_ENDPOINT / VITE_EXTENSION_PWA_URL are set via root .env files
 */

import { validateEndpointUrl } from "moo-family-bookshelf-shared/api/endpointUrl";

/**
 * Canonicalised at definition so it lives in the same comparison space as
 * `ApiClient.getEndpoint()` — otherwise a build-time env value with a trailing
 * slash or an uppercase host would make "already on the default endpoint" read
 * as a pending switch.
 *
 * A build whose env value FAILS validation throws here, at module load. That is
 * deliberate: `new ApiClient()` already threw on such a value, so the build was
 * dead either way — failing at the definition names the culprit instead of
 * surfacing as a mystery error deep in the first request.
 */
export const DEFAULT_API_ENDPOINT: string = validateEndpointUrl(
  import.meta.env?.VITE_EXTENSION_API_ENDPOINT ||
    "https://moo-family-bookshelf-dev.rcwork.workers.dev",
);

export const DEFAULT_PWA_URL: string =
  import.meta.env?.VITE_EXTENSION_PWA_URL ||
  "https://moo-family-bookshelf-dev.pages.dev";

export const PERSONAL_BOOKS_CACHE_KEY = "moo:personalBooksCache";

// --- Storage Keys ---
// All keys are prefixed with `moo:` to namespace them (consistent with the PWA).
// Legacy unprefixed keys are migrated on extension update — see storage/migrate.ts.

// Auth
export const USER_ID_KEY = "moo:userId";
export const AUTH_TOKEN_KEY = "moo:authToken";
export const TOKEN_EXPIRES_AT_KEY = "moo:tokenExpiresAt";
// Epoch ms until which automatic recovery joins are suppressed after a 429.
export const RECOVERY_COOLDOWN_UNTIL_KEY = "moo:recoveryCooldownUntil";

// Family
export const FAMILY_ID_KEY = "moo:familyId";

// Profile
export const DISPLAY_NAME_KEY = "moo:displayName";
export const USER_EMAIL_KEY = "moo:userEmail";

// Config
export const API_ENDPOINT_KEY = "moo:apiEndpoint";
/**
 * The family API endpoint the user last refused to switch to. storage.local
 * only (never sync) — like API_ENDPOINT_KEY this is a per-device decision.
 *
 * Value shape: `{ value: string | null }`, where `value` is the refused target
 * endpoint URL, or `null` for the "revert to the official default" direction.
 * The wrapper object is what keeps "declined the official default" (`value:
 * null`) distinguishable from "no decision recorded" (key absent). The switch
 * prompt reappears only when the family record moves to a value DIFFERENT from
 * the one stored here — see storage/familyEndpointChoice.ts.
 */
export const DECLINED_FAMILY_ENDPOINT_KEY = "moo:declinedFamilyEndpoint";
export const HAS_COMPLETED_INITIAL_SETUP_KEY = "moo:hasCompletedInitialSetup";

// Sync
export const SYNC_ARCHIVED_KEY = "moo:syncArchived";
export const AUTO_SYNC_INTERVAL_KEY = "moo:autoSyncInterval";
export const LAST_SYNC_AT_KEY = "moo:lastSyncAt";

// UI Preferences
export const FAMILY_SHELF_VIEW_MODE_KEY = "moo:familyShelfViewMode";
export const FLOATING_ICON_SIZE_KEY = "moo:floatingIconSize";
export const FAMILY_SHELF_SORT_KEY = "moo:familyShelfSort";
export const PERSONAL_SHELF_SORT_KEY = "moo:personalShelfSort";

// One-time flags
export const MANUAL_LEND_NOTICE_DISMISSED_KEY = "moo:manualLendNoticeDismissed";
export const PERSONAL_SHELF_SAVED_AT_KEY = "moo:personalShelfSavedAt";

// Storage migration flag
export const STORAGE_MIGRATED_KEY = "moo:storageMigrated";

// Dynamic key builders for update tracking
export function seenKey(userId: string): string {
  return `moo:familyBookshelfSeen:${userId}`;
}

export function chipsKey(userId: string): string {
  return `moo:familyBookshelfChips:${userId}`;
}

/**
 * Build PWA URL with auth data in the fragment (never sent to server).
 * Format: https://pwa.example.com/#code={syncCode}&uid={userId}[&qrt={qrToken}]
 */
export function buildPwaUrl(
  syncCode: string,
  userId: string,
  qrToken?: string,
): string {
  let url = `${DEFAULT_PWA_URL}/#code=${encodeURIComponent(syncCode)}&uid=${encodeURIComponent(userId)}`;
  if (qrToken) {
    url += `&qrt=${encodeURIComponent(qrToken)}`;
  }
  return url;
}

/**
 * Build PWA invite URL with sync code in the fragment (never sent to server).
 * Format: https://pwa.example.com/#invite={syncCode}
 */
export function buildInviteUrl(syncCode: string): string {
  return `${DEFAULT_PWA_URL}/#invite=${encodeURIComponent(syncCode)}`;
}
