import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BoolFlag,
  type ApiResponse,
} from "moo-family-bookshelf-shared/api/types";
import {
  ACCOUNT_SETTINGS_FIELDS,
  accountSettingsApi,
  sanitizeAccountSettings,
  sanitizeAccountSettingsResponse,
} from "moo-family-bookshelf-shared/api/accountSettings";
import {
  ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT,
  ACCOUNT_SETTINGS_LOCAL_ONLY,
  ACCOUNT_SETTINGS_SAVE_FAILED,
  SYNC_ARCHIVED_SHARED_NOTE,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";

/**
 * The account-settings record's boundary check and requests (#460, shared/src/api/accountSettings.ts),
 * which both `ApiClient`s use for `accountSettings.get` / `.patch`. A self-hosted server may answer
 * anything: each field is rebuilt on its own, a value outside its allowed set reads as ABSENT (never
 * as a default — absence is what the Extension's `ifAbsent` fill keys on), unknown keys are dropped,
 * and one aggregate `[accountSettingsValidation]` warning is logged. A reply whose `data` or
 * `data.settings` is not a plain object becomes a fresh `INVALID_RESPONSE` envelope; an `error`
 * passes through alone. `accountSettingsApi` builds `/api/user/:id/settings`, refusing a malformed
 * userId (`assertHexId`) before any request. The shared copy is pinned against its literals here.
 */

const USER = "a1".repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sanitizeAccountSettings", () => {
  it("keeps every valid field", () => {
    const full = {
      syncArchived: BoolFlag.TRUE,
      autoSyncInterval: "monthly",
      storePageChipEnabled: BoolFlag.FALSE,
      floatingIconSize: "icon",
    };
    expect(sanitizeAccountSettings(full)).toEqual(full);
    expect(ACCOUNT_SETTINGS_FIELDS).toEqual([
      "syncArchived",
      "autoSyncInterval",
      "storePageChipEnabled",
      "floatingIconSize",
    ]);
  });

  it.each([
    { field: "syncArchived", value: true },
    { field: "syncArchived", value: "1" },
    { field: "syncArchived", value: 2 },
    { field: "storePageChipEnabled", value: null },
    { field: "storePageChipEnabled", value: false },
    { field: "autoSyncInterval", value: "yearly" },
    { field: "autoSyncInterval", value: "DAILY" },
    { field: "floatingIconSize", value: 3 },
    { field: "floatingIconSize", value: ["small"] },
  ])("reads $field = $value as absent and warns once", ({ field, value }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = sanitizeAccountSettings({
      [field]: value,
      floatingIconSize: field === "floatingIconSize" ? value : "small",
    });

    expect(result).not.toHaveProperty(field);
    if (field !== "floatingIconSize") {
      expect(result).toEqual({ floatingIconSize: "small" });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "[accountSettingsValidation]",
    );
  });

  it.each([null, undefined, "settings", 1, [], [BoolFlag.TRUE]])(
    "reads the non-object %o as {}",
    (value) => {
      expect(sanitizeAccountSettings(value)).toEqual({});
    },
  );

  it("drops unknown keys without warning and fills in no defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Parsed like a wire reply, so `__proto__` is an own key, not the prototype.
    const result = sanitizeAccountSettings(
      JSON.parse(
        '{"autoSyncInterval":"never","__proto__":{"syncArchived":1},"extra":"x"}',
      ),
    );

    expect(result).toEqual({ autoSyncInterval: "never" });
    expect(Object.keys(result)).toEqual(["autoSyncInterval"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("sanitizeAccountSettingsResponse", () => {
  it("forwards an error alone, dropping any data beside it", () => {
    const error = { code: "FORBIDDEN", message: "no" };
    expect(
      sanitizeAccountSettingsResponse({
        error,
        data: { settings: { syncArchived: 1 } },
      } as ApiResponse<unknown>),
    ).toEqual({ error });
  });

  it("returns the rebuilt settings record as data", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      sanitizeAccountSettingsResponse({
        data: {
          ok: true,
          settings: { syncArchived: BoolFlag.TRUE, floatingIconSize: "huge" },
        },
      }),
    ).toEqual({ data: { syncArchived: BoolFlag.TRUE } });
  });

  it("returns an empty record for an empty settings object", () => {
    expect(sanitizeAccountSettingsResponse({ data: { settings: {} } })).toEqual(
      { data: {} },
    );
  });

  it.each([
    { name: "no data", res: {} },
    { name: "null data", res: { data: null } },
    { name: "array data", res: { data: [] } },
    { name: "no settings", res: { data: {} } },
    { name: "null settings", res: { data: { settings: null } } },
    { name: "string settings", res: { data: { settings: "on" } } },
    { name: "array settings", res: { data: { settings: [1] } } },
    { name: "a null error", res: { error: null, data: { settings: 3 } } },
  ])("returns INVALID_RESPONSE for $name", ({ res }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = sanitizeAccountSettingsResponse(res as ApiResponse<unknown>);

    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("INVALID_RESPONSE");
    expect(String(warn.mock.calls[0][0])).toContain(
      "[accountSettingsValidation]",
    );
  });
});

describe("accountSettingsApi", () => {
  function createVerbs(reply: ApiResponse<unknown>) {
    return {
      get: vi.fn().mockResolvedValue(reply),
      patch: vi.fn().mockResolvedValue(reply),
    };
  }

  it("GETs /api/user/:id/settings and validates the reply", async () => {
    const verbs = createVerbs({
      data: { settings: { autoSyncInterval: "weekly", other: 1 } },
    });

    const res = await accountSettingsApi(verbs).get(USER);

    expect(verbs.get).toHaveBeenCalledWith(`/api/user/${USER}/settings`);
    expect(res).toEqual({ data: { autoSyncInterval: "weekly" } });
  });

  it("PATCHes the body unchanged to the same path and validates the reply", async () => {
    const verbs = createVerbs({
      data: { ok: true, settings: { syncArchived: BoolFlag.TRUE } },
    });
    const body = {
      settings: { syncArchived: BoolFlag.TRUE },
      ifAbsent: { floatingIconSize: "large" as const },
    };

    const res = await accountSettingsApi(verbs).patch(USER, body);

    expect(verbs.patch).toHaveBeenCalledWith(
      `/api/user/${USER}/settings`,
      body,
    );
    expect(res).toEqual({ data: { syncArchived: BoolFlag.TRUE } });
  });

  it("turns a reply without a settings object into INVALID_RESPONSE", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const verbs = createVerbs({ data: { ok: true } });

    const res = await accountSettingsApi(verbs).patch(USER, {
      settings: { syncArchived: BoolFlag.FALSE },
    });

    expect(res.error?.code).toBe("INVALID_RESPONSE");
  });

  it.each([
    "",
    "../admin",
    `${"a1".repeat(31)}/x`,
    "A1".repeat(32),
    "a1".repeat(31),
    `${"a1".repeat(32)}0`,
  ])(
    "rejects the malformed userId %o before sending anything",
    async (userId) => {
      const verbs = createVerbs({ data: { settings: {} } });
      const api = accountSettingsApi(verbs);

      await expect(api.get(userId)).rejects.toThrow("Invalid userId");
      await expect(
        api.patch(userId, { settings: { syncArchived: BoolFlag.TRUE } }),
      ).rejects.toThrow("Invalid userId");
      expect(verbs.get).not.toHaveBeenCalled();
      expect(verbs.patch).not.toHaveBeenCalled();
    },
  );
});

describe("account-settings copy", () => {
  it("pins the shared literals", () => {
    expect(ACCOUNT_SETTINGS_SAVE_FAILED).toBe("儲存失敗，請稍後再試");
    expect(ACCOUNT_SETTINGS_LOCAL_ONLY).toBe(
      "伺服器尚未支援設定連動，這些設定只存在這個瀏覽器",
    );
    expect(ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT).toBe("這個設定跟著帳號。");
    expect(SYNC_ARCHIVED_SHARED_NOTE).toBe(
      "這個設定跟著帳號，擴充功能和手機版共用。",
    );
  });
});
