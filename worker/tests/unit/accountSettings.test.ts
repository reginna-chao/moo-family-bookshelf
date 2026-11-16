import { describe, it, expect } from "vitest";
import {
  ACCOUNT_SETTINGS_FIELDS,
  mergeAccountSettings,
  parseAccountSettingsPatch,
  toAccountSettingsRecord,
} from "../../src/services/accountSettings";
import { BoolFlag, type AccountSettingsRecord } from "../../src/kv/schema";

/**
 * The pure account-settings rules (#460, `src/services/accountSettings.ts`):
 * the `PATCH /api/user/:id/settings` body parse, the overwrite /
 * fill-if-absent merge, and the field-by-field rebuild of a stored value.
 * `account-settings.test.ts` drives the same rules through the route; this
 * file covers the input space the route cannot reach cheaply (every valid
 * value of every field, inherited and `__proto__` keys, input immutability).
 *
 * The rules under test:
 * - parse: a non-object body ⇒ `INVALID_PAYLOAD`; `settings` / `ifAbsent`
 *   present but not a plain object, a known OWN field with an invalid value,
 *   or no known field in either ⇒ `INVALID_SETTINGS` with a message naming the
 *   field. Unknown keys are dropped; an omitted object reads as `{}`.
 * - merge: `settings` overwrites; `ifAbsent` fills a field only when the
 *   stored record lacks it and `settings` does not name it. `changed` is true
 *   only when some field of the result differs from the stored one — `0` is a
 *   value, never "absent".
 * - rebuild: anything that is not a plain object reads as `{}`; an invalid or
 *   unknown field is dropped.
 */

const VALID_VALUES: Record<keyof AccountSettingsRecord, unknown[]> = {
  syncArchived: [BoolFlag.FALSE, BoolFlag.TRUE],
  autoSyncInterval: ["daily", "weekly", "monthly", "never"],
  storePageChipEnabled: [BoolFlag.FALSE, BoolFlag.TRUE],
  floatingIconSize: ["small", "medium", "large", "icon"],
};

const INVALID_VALUES: { label: string; value: unknown }[] = [
  { label: "null", value: null },
  { label: "true", value: true },
  { label: "false", value: false },
  { label: '"1"', value: "1" },
  { label: "2", value: 2 },
  { label: "-1", value: -1 },
  { label: "0.5", value: 0.5 },
  { label: "an object", value: {} },
  { label: "an array", value: ["daily"] },
  { label: "an empty string", value: "" },
  { label: "an uppercase string", value: "WEEKLY" },
];

const NO_KNOWN_FIELD = {
  code: "INVALID_SETTINGS",
  message: "settings or ifAbsent must carry at least one known setting",
};

describe("ACCOUNT_SETTINGS_FIELDS", () => {
  it("lists exactly the four account settings", () => {
    expect([...ACCOUNT_SETTINGS_FIELDS].sort()).toEqual(
      Object.keys(VALID_VALUES).sort(),
    );
  });
});

describe("parseAccountSettingsPatch", () => {
  it.each<{ label: string; body: unknown }>([
    { label: "undefined", body: undefined },
    { label: "null", body: null },
    { label: "an array", body: [{ settings: { syncArchived: 1 } }] },
    { label: "a number", body: 1 },
    { label: "a string", body: "settings" },
    { label: "a boolean", body: true },
  ])("answers INVALID_PAYLOAD when the body is $label", ({ body }) => {
    expect(parseAccountSettingsPatch(body)).toEqual({
      code: "INVALID_PAYLOAD",
      message: "Request body must be an object",
    });
  });

  const fieldValueRows = Object.entries(VALID_VALUES).flatMap(
    ([field, values]) => values.map((value) => ({ field, value })),
  );

  it.each(fieldValueRows)(
    "accepts $field = $value in settings and in ifAbsent",
    ({ field, value }) => {
      expect(
        parseAccountSettingsPatch({ settings: { [field]: value } }),
      ).toEqual({ settings: { [field]: value }, ifAbsent: {} });
      expect(
        parseAccountSettingsPatch({ ifAbsent: { [field]: value } }),
      ).toEqual({ settings: {}, ifAbsent: { [field]: value } });
    },
  );

  const invalidRows = ACCOUNT_SETTINGS_FIELDS.flatMap((field) =>
    INVALID_VALUES.map(({ label, value }) => ({ field, label, value })),
  );

  it.each(invalidRows)(
    "names settings.$field when it is $label",
    ({ field, value }) => {
      expect(
        parseAccountSettingsPatch({ settings: { [field]: value } }),
      ).toEqual({
        code: "INVALID_SETTINGS",
        message: `settings.${field} has an invalid value`,
      });
    },
  );

  it.each(invalidRows)(
    "names ifAbsent.$field when it is $label",
    ({ field, value }) => {
      expect(
        parseAccountSettingsPatch({
          settings: { syncArchived: BoolFlag.TRUE },
          ifAbsent: { [field]: value },
        }),
      ).toEqual({
        code: "INVALID_SETTINGS",
        message: `ifAbsent.${field} has an invalid value`,
      });
    },
  );

  it("rejects a string value of the OTHER field's union (a size is not an interval)", () => {
    expect(
      parseAccountSettingsPatch({ settings: { autoSyncInterval: "icon" } }),
    ).toEqual({
      code: "INVALID_SETTINGS",
      message: "settings.autoSyncInterval has an invalid value",
    });
    expect(
      parseAccountSettingsPatch({ settings: { floatingIconSize: "never" } }),
    ).toEqual({
      code: "INVALID_SETTINGS",
      message: "settings.floatingIconSize has an invalid value",
    });
  });

  it.each<{ label: string; value: unknown }>([
    { label: "null", value: null },
    { label: "an array", value: [] },
    { label: "a string", value: "weekly" },
    { label: "a number", value: 1 },
    { label: "a boolean", value: false },
  ])("answers INVALID_SETTINGS when settings is $label", ({ value }) => {
    expect(parseAccountSettingsPatch({ settings: value })).toEqual({
      code: "INVALID_SETTINGS",
      message: "settings must be an object",
    });
  });

  it.each<{ label: string; value: unknown }>([
    { label: "null", value: null },
    { label: "an array", value: [{ syncArchived: 1 }] },
    { label: "a string", value: "weekly" },
  ])("answers INVALID_SETTINGS when ifAbsent is $label", ({ value }) => {
    expect(
      parseAccountSettingsPatch({
        settings: { syncArchived: BoolFlag.TRUE },
        ifAbsent: value,
      }),
    ).toEqual({
      code: "INVALID_SETTINGS",
      message: "ifAbsent must be an object",
    });
  });

  it.each<{ label: string; body: unknown }>([
    { label: "an empty body", body: {} },
    { label: "two empty objects", body: { settings: {}, ifAbsent: {} } },
    {
      label: "unknown keys only",
      body: { settings: { theme: "dark" }, ifAbsent: { bookSort: "title" } },
    },
    { label: "fields at the top level", body: { syncArchived: 1 } },
    {
      // JSON.parse makes `__proto__` an OWN key; it is unknown, never a prototype.
      label: "a __proto__ key carrying a field",
      body: JSON.parse('{"settings":{"__proto__":{"syncArchived":1}}}'),
    },
    {
      label: "a field that is only inherited",
      body: { settings: Object.create({ syncArchived: BoolFlag.TRUE }) },
    },
  ])("answers INVALID_SETTINGS when the body carries $label", ({ body }) => {
    expect(parseAccountSettingsPatch(body)).toEqual(NO_KNOWN_FIELD);
  });

  it("drops unknown keys and keeps both objects' known fields", () => {
    expect(
      parseAccountSettingsPatch({
        settings: { syncArchived: BoolFlag.TRUE, theme: "dark" },
        ifAbsent: { floatingIconSize: "icon", bookSort: "title" },
        userId: "someone-else",
      }),
    ).toEqual({
      settings: { syncArchived: BoolFlag.TRUE },
      ifAbsent: { floatingIconSize: "icon" },
    });
  });

  it("does not hand back the caller's objects", () => {
    const settings = { autoSyncInterval: "daily" };
    const parsed = parseAccountSettingsPatch({ settings });

    expect(parsed).toEqual({ settings, ifAbsent: {} });
    expect("settings" in parsed && parsed.settings).not.toBe(settings);
  });
});

describe("mergeAccountSettings", () => {
  const STORED: AccountSettingsRecord = {
    syncArchived: BoolFlag.TRUE,
    autoSyncInterval: "daily",
  };

  it.each<{
    label: string;
    stored: AccountSettingsRecord;
    settings: AccountSettingsRecord;
    ifAbsent: AccountSettingsRecord;
    next: AccountSettingsRecord;
    changed: boolean;
  }>([
    {
      label: "settings overwrites a named field and keeps the others",
      stored: STORED,
      settings: { autoSyncInterval: "never" },
      ifAbsent: {},
      next: { syncArchived: BoolFlag.TRUE, autoSyncInterval: "never" },
      changed: true,
    },
    {
      label: "settings adds a field the server lacks",
      stored: STORED,
      settings: { floatingIconSize: "large" },
      ifAbsent: {},
      next: { ...STORED, floatingIconSize: "large" },
      changed: true,
    },
    {
      label: "settings writes 0 over a stored 1",
      stored: STORED,
      settings: { syncArchived: BoolFlag.FALSE },
      ifAbsent: {},
      next: { syncArchived: BoolFlag.FALSE, autoSyncInterval: "daily" },
      changed: true,
    },
    {
      label: "settings repeating every stored value",
      stored: STORED,
      settings: { ...STORED },
      ifAbsent: {},
      next: STORED,
      changed: false,
    },
    {
      label: "ifAbsent fills a field the server lacks",
      stored: STORED,
      settings: {},
      ifAbsent: { storePageChipEnabled: BoolFlag.TRUE },
      next: { ...STORED, storePageChipEnabled: BoolFlag.TRUE },
      changed: true,
    },
    {
      label: "ifAbsent leaves a field the server holds",
      stored: STORED,
      settings: {},
      ifAbsent: { autoSyncInterval: "monthly" },
      next: STORED,
      changed: false,
    },
    {
      label: "ifAbsent never replaces a stored 0",
      stored: { storePageChipEnabled: BoolFlag.FALSE },
      settings: {},
      ifAbsent: { storePageChipEnabled: BoolFlag.TRUE },
      next: { storePageChipEnabled: BoolFlag.FALSE },
      changed: false,
    },
    {
      label: "ifAbsent fills a 0 into an empty record",
      stored: {},
      settings: {},
      ifAbsent: { syncArchived: BoolFlag.FALSE },
      next: { syncArchived: BoolFlag.FALSE },
      changed: true,
    },
    {
      label: "settings wins over ifAbsent on a field the server lacks",
      stored: {},
      settings: { floatingIconSize: "small" },
      ifAbsent: { floatingIconSize: "icon" },
      next: { floatingIconSize: "small" },
      changed: true,
    },
    {
      label: "settings wins over ifAbsent on a field the server holds",
      stored: { floatingIconSize: "medium" },
      settings: { floatingIconSize: "small" },
      ifAbsent: { floatingIconSize: "icon" },
      next: { floatingIconSize: "small" },
      changed: true,
    },
    {
      label: "both objects together, each on its own field",
      stored: { syncArchived: BoolFlag.FALSE },
      settings: { autoSyncInterval: "weekly" },
      ifAbsent: {
        syncArchived: BoolFlag.TRUE,
        storePageChipEnabled: BoolFlag.TRUE,
      },
      next: {
        syncArchived: BoolFlag.FALSE,
        autoSyncInterval: "weekly",
        storePageChipEnabled: BoolFlag.TRUE,
      },
      changed: true,
    },
    {
      label: "an empty patch",
      stored: STORED,
      settings: {},
      ifAbsent: {},
      next: STORED,
      changed: false,
    },
    {
      label: "an empty patch on an empty record",
      stored: {},
      settings: {},
      ifAbsent: {},
      next: {},
      changed: false,
    },
  ])("$label", ({ stored, settings, ifAbsent, next, changed }) => {
    expect(mergeAccountSettings(stored, settings, ifAbsent)).toEqual({
      next,
      changed,
    });
  });

  it("returns a new record and leaves its three inputs untouched", () => {
    const stored = { ...STORED };
    const settings = { autoSyncInterval: "never" as const };
    const ifAbsent = { floatingIconSize: "icon" as const };

    const { next } = mergeAccountSettings(stored, settings, ifAbsent);

    expect(next).not.toBe(stored);
    expect(stored).toEqual(STORED);
    expect(settings).toEqual({ autoSyncInterval: "never" });
    expect(ifAbsent).toEqual({ floatingIconSize: "icon" });
  });

  it("never carries an absent field as an explicit undefined key", () => {
    const { next } = mergeAccountSettings(
      {},
      { syncArchived: BoolFlag.TRUE },
      {},
    );

    expect(Object.keys(next)).toEqual(["syncArchived"]);
  });
});

describe("toAccountSettingsRecord", () => {
  it.each<{ label: string; value: unknown }>([
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "a number", value: 1 },
    { label: "a string", value: "weekly" },
    { label: "a boolean", value: true },
    { label: "an empty array", value: [] },
    { label: "an array of records", value: [{ syncArchived: 1 }] },
  ])("reads $label as {}", ({ value }) => {
    expect(toAccountSettingsRecord(value)).toEqual({});
  });

  it("keeps every valid field", () => {
    const full: AccountSettingsRecord = {
      syncArchived: BoolFlag.FALSE,
      autoSyncInterval: "never",
      storePageChipEnabled: BoolFlag.TRUE,
      floatingIconSize: "medium",
    };

    expect(toAccountSettingsRecord({ ...full })).toEqual(full);
  });

  it("drops invalid and unknown fields and keeps the valid ones", () => {
    expect(
      toAccountSettingsRecord({
        syncArchived: true,
        autoSyncInterval: "weekly",
        storePageChipEnabled: 2,
        floatingIconSize: "huge",
        lastUpdated: "2020-01-01",
      }),
    ).toEqual({ autoSyncInterval: "weekly" });
  });

  it.each(
    ACCOUNT_SETTINGS_FIELDS.flatMap((field) =>
      INVALID_VALUES.map(({ label, value }) => ({ field, label, value })),
    ),
  )("drops $field when it is $label", ({ field, value }) => {
    expect(
      // The companion goes first, so on the floatingIconSize row the bad value replaces it.
      toAccountSettingsRecord({ floatingIconSize: "small", [field]: value }),
    ).toEqual(
      field === "floatingIconSize" ? {} : { floatingIconSize: "small" },
    );
  });

  it("returns a fresh object, never the stored one", () => {
    const stored = { syncArchived: BoolFlag.TRUE };

    expect(toAccountSettingsRecord(stored)).not.toBe(stored);
  });
});
