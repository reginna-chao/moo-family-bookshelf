/** Pure rules of the account settings (#460): which fields exist, what a valid value is, the
 *  `PATCH /api/user/:id/settings` body parse and the overwrite / fill-if-absent merge. No I/O. */
import {
  isAutoSyncInterval,
  isFloatingIconSize,
} from "moo-family-bookshelf-shared/api/accountSettingsValues";
import { BoolFlag, type AccountSettingsRecord } from "../kv/schema";

export type AccountSettingsField = keyof AccountSettingsRecord;

type FieldGuards = {
  [K in AccountSettingsField]-?: (
    value: unknown,
  ) => value is NonNullable<AccountSettingsRecord[K]>;
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

/** The four field names, in a fixed order. */
export const ACCOUNT_SETTINGS_FIELDS = Object.keys(
  FIELD_GUARDS,
) as AccountSettingsField[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Set `target[field]` to `value` when it is valid for that field; otherwise leave the field unset. */
function copyField<K extends AccountSettingsField>(
  target: AccountSettingsRecord,
  field: K,
  value: unknown,
): void {
  // The guard narrows to the field's value type; TS cannot relate it to the generic index on its own.
  if (FIELD_GUARDS[field](value))
    target[field] = value as AccountSettingsRecord[K];
}

/**
 * Rebuild a record field by field from any value: anything that is not a plain
 * object reads as `{}`, an invalid or unknown field is dropped. Used on the
 * stored value, so a corrupt record never reaches a response or a merge.
 */
export function toAccountSettingsRecord(value: unknown): AccountSettingsRecord {
  const record: AccountSettingsRecord = {};
  if (!isPlainObject(value)) return record;
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    copyField(record, field, value[field]);
  }
  return record;
}

interface ParseError {
  code: string;
  message: string;
}

/** One body object (`settings` / `ifAbsent`): omitted ⇒ `{}`, unknown keys ignored, a bad value ⇒ an error naming it. */
function parsePatchObject(
  value: unknown,
  name: "settings" | "ifAbsent",
): AccountSettingsRecord | ParseError {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    return { code: "INVALID_SETTINGS", message: `${name} must be an object` };
  }
  const record: AccountSettingsRecord = {};
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (!FIELD_GUARDS[field](value[field])) {
      return {
        code: "INVALID_SETTINGS",
        message: `${name}.${field} has an invalid value`,
      };
    }
    copyField(record, field, value[field]);
  }
  return record;
}

function isParseError(
  value: AccountSettingsRecord | ParseError,
): value is ParseError {
  return "code" in value;
}

/**
 * Classify a `PATCH /api/user/:id/settings` body `{ settings?, ifAbsent? }`.
 * Not a plain object ⇒ `INVALID_PAYLOAD`; `settings` / `ifAbsent` present but
 * not an object, a known field with an invalid value, or no known field in
 * either ⇒ `INVALID_SETTINGS` (message names the field). Unknown keys are
 * ignored; an omitted object reads as `{}`.
 */
export function parseAccountSettingsPatch(
  body: unknown,
):
  | { settings: AccountSettingsRecord; ifAbsent: AccountSettingsRecord }
  | ParseError {
  if (!isPlainObject(body)) {
    return {
      code: "INVALID_PAYLOAD",
      message: "Request body must be an object",
    };
  }
  const settings = parsePatchObject(body.settings, "settings");
  if (isParseError(settings)) return settings;
  const ifAbsent = parsePatchObject(body.ifAbsent, "ifAbsent");
  if (isParseError(ifAbsent)) return ifAbsent;
  if (Object.keys(settings).length + Object.keys(ifAbsent).length === 0) {
    return {
      code: "INVALID_SETTINGS",
      message: "settings or ifAbsent must carry at least one known setting",
    };
  }
  return { settings, ifAbsent };
}

/** The value `field` takes after a merge: `settings` overwrites; `ifAbsent` fills only a field still unset. */
function mergedValue<K extends AccountSettingsField>(
  field: K,
  stored: AccountSettingsRecord,
  settings: AccountSettingsRecord,
  ifAbsent: AccountSettingsRecord,
): AccountSettingsRecord[K] {
  if (settings[field] !== undefined) return settings[field];
  if (stored[field] !== undefined) return stored[field];
  return ifAbsent[field];
}

/**
 * Merge a parsed patch into the stored record: every field in `settings`
 * overwrites, then every field in `ifAbsent` is written only when `stored`
 * has no value for it and `settings` does not name it. `changed` is whether
 * any field differs from `stored`, so an unchanged merge costs no KV write.
 */
export function mergeAccountSettings(
  stored: AccountSettingsRecord,
  settings: AccountSettingsRecord,
  ifAbsent: AccountSettingsRecord,
): { next: AccountSettingsRecord; changed: boolean } {
  const next: AccountSettingsRecord = {};
  let changed = false;
  for (const field of ACCOUNT_SETTINGS_FIELDS) {
    const value = mergedValue(field, stored, settings, ifAbsent);
    copyField(next, field, value);
    if (value !== stored[field]) changed = true;
  }
  return { next, changed };
}
