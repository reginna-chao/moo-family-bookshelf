/** Account settings (#460): the client-side record, its boundary check and the two requests both
 *  `ApiClient`s share. Why the check: docs/architecture.md → 伺服器回傳資料的檢查. */

import {
  isAutoSyncInterval,
  isFloatingIconSize,
  type AutoSyncInterval,
  type FloatingIconSize,
} from "./accountSettingsValues";
import { assertHexId } from "./hexId";
import { BoolFlag, type ApiResponse } from "./types";

/** The settings that follow the account; a field the server holds no value for is absent. */
export interface AccountSettings {
  syncArchived?: BoolFlag;
  autoSyncInterval?: AutoSyncInterval;
  storePageChipEnabled?: BoolFlag;
  floatingIconSize?: FloatingIconSize;
}

export type AccountSettingsField = keyof AccountSettings;

/** `PATCH /api/user/:id/settings` body: `settings` overwrite, `ifAbsent` fill only what the server lacks. */
export interface AccountSettingsPatch {
  settings?: AccountSettings;
  ifAbsent?: AccountSettings;
}

type FieldGuards = {
  [K in AccountSettingsField]-?: (
    value: unknown,
  ) => value is NonNullable<AccountSettings[K]>;
};

function isBoolFlag(value: unknown): value is BoolFlag {
  return value === BoolFlag.FALSE || value === BoolFlag.TRUE;
}

const FIELD_GUARDS: FieldGuards = {
  syncArchived: isBoolFlag,
  autoSyncInterval: isAutoSyncInterval,
  storePageChipEnabled: isBoolFlag,
  floatingIconSize: isFloatingIconSize,
};

/** The four field names, in the order the Worker lists them. */
export const ACCOUNT_SETTINGS_FIELDS: readonly AccountSettingsField[] = [
  "syncArchived",
  "autoSyncInterval",
  "storePageChipEnabled",
  "floatingIconSize",
];

/** Reject primitives, `null`, and arrays; only a plain object can carry settings. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set `target[field]` when `value` is valid for that field; otherwise leave it unset. */
function copyField<K extends AccountSettingsField>(
  target: AccountSettings,
  field: K,
  value: unknown,
): boolean {
  // The guard narrows to the field's value type; TS cannot relate it to the generic index on its own.
  if (!FIELD_GUARDS[field](value)) return false;
  target[field] = value as AccountSettings[K];
  return true;
}

/**
 * Rebuild an account-settings record field by field from any value. Anything
 * that is not a plain object reads as `{}`; a field whose value is not one of
 * its allowed values reads as absent; unknown keys are dropped. Never throws,
 * and fills in no defaults — an absent field stays absent.
 */
export function sanitizeAccountSettings(value: unknown): AccountSettings {
  const settings: AccountSettings = {};
  if (!isRecord(value)) return settings;
  let dropped = false;
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (!copyField(settings, field, raw)) dropped = true;
  }
  if (dropped) {
    console.warn(
      "[accountSettingsValidation] ignored account settings with an unknown value",
    );
  }
  return settings;
}

/**
 * Validate a `GET` / `PATCH /api/user/:id/settings` envelope at the API
 * boundary. An `error` is forwarded alone (any `data` beside it dropped). A
 * `data` that is not a plain object, or whose `settings` is not one, becomes a
 * fresh `INVALID_RESPONSE` error envelope; otherwise `data` is the rebuilt
 * settings record alone (`sanitizeAccountSettings`), never the raw object.
 */
export function sanitizeAccountSettingsResponse(
  res: ApiResponse<unknown>,
): ApiResponse<AccountSettings> {
  // Truthiness, as in the other boundary checks: a BYO `error: null` must not skip validation.
  if (res.error) return { error: res.error };
  const settings = isRecord(res.data) ? res.data.settings : undefined;
  if (isRecord(settings)) return { data: sanitizeAccountSettings(settings) };
  console.warn(
    "[accountSettingsValidation] ignored an account-settings response without a settings object",
  );
  return {
    error: {
      code: "INVALID_RESPONSE",
      message: "response is not a valid account settings record",
    },
  };
}

/** The HTTP verbs of an `ApiClient` that `accountSettingsApi` needs; both read the body as `unknown`. */
export interface AccountSettingsVerbs {
  get(path: string): Promise<ApiResponse<unknown>>;
  patch(path: string, body: unknown): Promise<ApiResponse<unknown>>;
}

/** The account-settings requests an `ApiClient` exposes as its `accountSettings` field. */
export interface AccountSettingsApi {
  get(userId: string): Promise<ApiResponse<AccountSettings>>;
  patch(
    userId: string,
    patch: AccountSettingsPatch,
  ): Promise<ApiResponse<AccountSettings>>;
}

function settingsPath(userId: string): string {
  assertHexId(userId, "userId");
  return `/api/user/${userId}/settings`;
}

/**
 * Bind the two account-settings requests to an `ApiClient`'s HTTP verbs, so
 * the Extension and the PWA send the same path and check every reply the same
 * way (`sanitizeAccountSettingsResponse`). A malformed userId rejects the
 * returned promise (`assertHexId`) before anything is sent.
 */
export function accountSettingsApi(
  verbs: AccountSettingsVerbs,
): AccountSettingsApi {
  return {
    async get(userId) {
      const res = await verbs.get(settingsPath(userId));
      return sanitizeAccountSettingsResponse(res);
    },
    async patch(userId, patch) {
      const res = await verbs.patch(settingsPath(userId), patch);
      return sanitizeAccountSettingsResponse(res);
    },
  };
}
