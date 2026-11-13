import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AccountSettingsSync,
  ACCOUNT_SETTINGS_WRITE_GAP_MS,
} from "@/dialog/accountSettingsSync";
import { BoolFlag, type ApiClient, type ApiResponse } from "@/api/client";
import type { AccountSettings } from "moo-family-bookshelf-shared/api/accountSettings";
import {
  ACCOUNT_SETTINGS_PENDING_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  FLOATING_ICON_SIZE_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  SYNC_ARCHIVED_KEY,
  USER_ID_KEY,
} from "@/constants";
import { writePendingAccountSetting } from "@/storage/accountSettingsPending";
import {
  createAccountSettingsServer,
  type FakeAccountSettingsServer,
} from "../../helpers/accountSettingsServer";

/**
 * `AccountSettingsSync` (#460): the per-Dialog-open controller of the four account settings. Runs
 * against the store-backed storage mock of tests/setup.ts (cleared around every case, so a read sees
 * what a write stored) and the in-memory server of tests/helpers/accountSettingsServer.tsx, which
 * applies the PATCH contract (`ifAbsent` fills absent fields, `settings` overwrites).
 *
 * refresh: one GET; this account's pending marker goes up in `settings`, every field this browser
 * stored that the server lacks in `ifAbsent` — both in ONE PATCH, never more per open; then the
 * server's values are cached locally. A field the controller is saving, or whose stored value moved
 * off the snapshot taken before the GET (another tab, the options page), is "protected": never
 * uploaded and never followed. A failed upload keeps the marker and the marked fields' local values
 * and still resolves `followed` (accepted deviation 4 in PLAN.md → Fix Cycle Log). A 404 `NOT_FOUND`
 * is a server without the feature: `unsupported`, the marker is dropped, every later save writes
 * locally. Any other GET error is `failed` and writes nothing. A client that moved to another
 * endpoint (or a disposed controller) makes a reply `stale`: nothing is written.
 *
 * save: storage.local is written only after the server confirmed, and only when the stored value is
 * still the one read when the save started (deviation 5: `before` is captured at entry, ahead of the
 * PATCH queue's gap); the marker is cleared only for fields still holding the sent value.
 *
 * R1 (PLAN.md 四、併發表): a marker holding V1, and a save of V2 landing before the open-time GET
 * returns — the refresh must not upload V1 afterwards. Every PATCH of one controller goes through a
 * queue that leaves `ACCOUNT_SETTINGS_WRITE_GAP_MS` after the previous reply (KV: one write per
 * second per key); those cases run on fake timers, restored by the file-level `afterEach`.
 */

const USER = "a1b2c3d4e5f60718";
const OTHER_USER = "ffffeeee00001111";
const OTHER_ENDPOINT = "https://other.example.test";

let created: AccountSettingsSync[] = [];

function createSync(server: FakeAccountSettingsServer): AccountSettingsSync {
  const sync = new AccountSettingsSync(server.client, USER);
  created.push(sync);
  return sync;
}

/** Seed storage.local, then forget the seeding writes so a case counts only production's. */
async function seed(items: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(items);
  vi.mocked(chrome.storage.local.set).mockClear();
  vi.mocked(chrome.storage.local.remove).mockClear();
}

async function stored(): Promise<Record<string, unknown>> {
  return (await chrome.storage.local.get(null)) as Record<string, unknown>;
}

function marker(settings: AccountSettings, userId = USER) {
  return { [ACCOUNT_SETTINGS_PENDING_KEY]: { userId, settings } };
}

function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every queued promise callback run (real timers only). */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** Track whether a promise has resolved yet. */
function watch(promise: Promise<unknown>) {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  await seed({ [USER_ID_KEY]: USER });
});

afterEach(() => {
  for (const sync of created) sync.dispose();
  created = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AccountSettingsSync.refresh", () => {
  it("follows the fields the server holds and writes only the ones that differ", async () => {
    await seed({
      [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE,
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
    });
    const server = createAccountSettingsServer({
      syncArchived: BoolFlag.TRUE,
      autoSyncInterval: "weekly",
    });

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.get).toHaveBeenCalledTimes(1);
    expect(server.get).toHaveBeenCalledWith(USER);
    expect(server.patch).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
    });
    const after = await stored();
    expect(after[SYNC_ARCHIVED_KEY]).toBe(BoolFlag.TRUE);
    // A field neither side holds gets no default written.
    expect(after).not.toHaveProperty(FLOATING_ICON_SIZE_KEY);
    expect(after).not.toHaveProperty(STORE_PAGE_CHIP_ENABLED_KEY);
  });

  it("fills only the stored fields the server lacks, in ifAbsent, and follows the rest", async () => {
    await seed({
      [AUTO_SYNC_INTERVAL_KEY]: "monthly",
      [FLOATING_ICON_SIZE_KEY]: "small",
    });
    const server = createAccountSettingsServer({ floatingIconSize: "large" });

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.patch).toHaveBeenCalledTimes(1);
    const [userId, body] = server.patch.mock.calls[0];
    expect(userId).toBe(USER);
    expect(body).toEqual({ ifAbsent: { autoSyncInterval: "monthly" } });
    expect(Object.keys(body)).toEqual(["ifAbsent"]);
    expect(server.record).toEqual({
      autoSyncInterval: "monthly",
      floatingIconSize: "large",
    });
    const after = await stored();
    expect(after[FLOATING_ICON_SIZE_KEY]).toBe("large");
    expect(after[AUTO_SYNC_INTERVAL_KEY]).toBe("monthly");
  });

  it("uploads this account's pending marker in settings and clears it once the server took it", async () => {
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer({
      storePageChipEnabled: BoolFlag.FALSE,
    });

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.patch).toHaveBeenCalledTimes(1);
    const [, body] = server.patch.mock.calls[0];
    expect(body).toEqual({
      settings: { storePageChipEnabled: BoolFlag.TRUE },
    });
    expect(server.record.storePageChipEnabled).toBe(BoolFlag.TRUE);
    const after = await stored();
    expect(after).not.toHaveProperty(ACCOUNT_SETTINGS_PENDING_KEY);
    expect(after[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.TRUE);
  });

  it("sends nothing from another account's marker and leaves that marker alone", async () => {
    const otherMarker = marker(
      { storePageChipEnabled: BoolFlag.TRUE },
      OTHER_USER,
    );
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      ...otherMarker,
    });
    const server = createAccountSettingsServer({
      storePageChipEnabled: BoolFlag.FALSE,
    });

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.patch).not.toHaveBeenCalled();
    const after = await stored();
    expect(after[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.FALSE);
    expect(after[ACCOUNT_SETTINGS_PENDING_KEY]).toEqual(
      otherMarker[ACCOUNT_SETTINGS_PENDING_KEY],
    );
  });

  it("sends the pending upload and the fill together in a single PATCH", async () => {
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [AUTO_SYNC_INTERVAL_KEY]: "never",
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer();

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(server.patch.mock.calls[0][1]).toEqual({
      settings: { storePageChipEnabled: BoolFlag.TRUE },
      ifAbsent: { autoSyncInterval: "never" },
    });
    expect(server.record).toEqual({
      storePageChipEnabled: BoolFlag.TRUE,
      autoSyncInterval: "never",
    });
  });

  it("keeps the marker and the marked field's local value when the upload fails, following the rest", async () => {
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE,
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer({
      storePageChipEnabled: BoolFlag.FALSE,
      syncArchived: BoolFlag.TRUE,
    });
    server.patch.mockResolvedValueOnce({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });

    await expect(createSync(server).refresh()).resolves.toBe("followed");

    expect(server.patch).toHaveBeenCalledTimes(1);
    const after = await stored();
    expect(after[ACCOUNT_SETTINGS_PENDING_KEY]).toEqual(
      marker({ storePageChipEnabled: BoolFlag.TRUE })[
        ACCOUNT_SETTINGS_PENDING_KEY
      ],
    );
    expect(after[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.TRUE);
    expect(after[SYNC_ARCHIVED_KEY]).toBe(BoolFlag.TRUE);
  });

  it.each([
    "INVALID_RESPONSE",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "NETWORK_ERROR",
  ])(
    "resolves failed on a %s GET and writes, uploads and clears nothing",
    async (code) => {
      await seed({
        [AUTO_SYNC_INTERVAL_KEY]: "weekly",
        ...marker({ autoSyncInterval: "weekly" }),
      });
      const server = createAccountSettingsServer({
        autoSyncInterval: "never",
      });
      server.get.mockResolvedValueOnce({ error: { code, message: code } });
      const sync = createSync(server);

      await expect(sync.refresh()).resolves.toBe("failed");

      expect(sync.isUnsupported()).toBe(false);
      expect(server.patch).not.toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    },
  );

  it("turns unsupported on a 404 NOT_FOUND GET: marker dropped, local values kept, later saves stay local", async () => {
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer();
    server.get.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const sync = createSync(server);
    const listener = vi.fn();
    sync.subscribe(listener);

    await expect(sync.refresh()).resolves.toBe("unsupported");

    expect(sync.isUnsupported()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(server.patch).not.toHaveBeenCalled();
    let after = await stored();
    expect(after).not.toHaveProperty(ACCOUNT_SETTINGS_PENDING_KEY);
    expect(after[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.TRUE);

    await expect(sync.save("floatingIconSize", "large")).resolves.toBe(
      "localOnly",
    );
    expect(server.patch).not.toHaveBeenCalled();
    after = await stored();
    expect(after[FLOATING_ICON_SIZE_KEY]).toBe("large");
  });

  it.each([
    {
      name: "the client moved to another endpoint",
      interrupt: (server: FakeAccountSettingsServer) =>
        server.setEndpoint(OTHER_ENDPOINT),
    },
    {
      name: "the controller was disposed",
      interrupt: (
        _server: FakeAccountSettingsServer,
        sync: AccountSettingsSync,
      ) => sync.dispose(),
    },
  ])(
    "resolves stale and writes nothing when $name while the GET was out",
    async ({ interrupt }) => {
      await seed({ [AUTO_SYNC_INTERVAL_KEY]: "weekly" });
      const server = createAccountSettingsServer({
        autoSyncInterval: "never",
        syncArchived: BoolFlag.TRUE,
      });
      const reply = held<ApiResponse<AccountSettings>>();
      server.get.mockReturnValueOnce(reply.promise);
      const sync = createSync(server);

      const refreshing = sync.refresh();
      await vi.waitFor(() => expect(server.get).toHaveBeenCalled());
      interrupt(server, sync);
      reply.release({ data: { ...server.record } });

      await expect(refreshing).resolves.toBe("stale");
      expect(server.patch).not.toHaveBeenCalled();
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    },
  );

  it("resolves stale and sends no GET when the endpoint changes while the snapshot is being read", async () => {
    await seed({ [AUTO_SYNC_INTERVAL_KEY]: "weekly" });
    const server = createAccountSettingsServer({ autoSyncInterval: "never" });
    const localGet = vi.mocked(
      chrome.storage.local.get as unknown as (
        keys?: unknown,
      ) => Promise<Record<string, unknown>>,
    );
    const snapshotRead = held<void>();
    // The refresh's first storage read is its snapshot: hold it until the endpoint has moved,
    // then answer from the store (the once-override is spent, so this call reads it).
    localGet.mockImplementationOnce(async (keys) => {
      await snapshotRead.promise;
      return localGet(keys);
    });
    const sync = createSync(server);

    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(localGet).toHaveBeenCalled());
    server.setEndpoint(OTHER_ENDPOINT);
    snapshotRead.release();

    await expect(refreshing).resolves.toBe("stale");
    expect(server.get).not.toHaveBeenCalled();
  });

  it("resolves stale and follows nothing when the endpoint changes while its PATCH is out", async () => {
    await seed({
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer({ syncArchived: BoolFlag.TRUE });
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const sync = createSync(server);

    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(server.patch).toHaveBeenCalled());
    server.setEndpoint(OTHER_ENDPOINT);
    reply.release({
      data: {
        syncArchived: BoolFlag.TRUE,
        autoSyncInterval: "weekly",
        storePageChipEnabled: BoolFlag.TRUE,
      },
    });

    await expect(refreshing).resolves.toBe("stale");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    expect((await stored())[SYNC_ARCHIVED_KEY]).toBeUndefined();
  });

  it("neither fills nor follows a field this controller is saving", async () => {
    await seed({ [AUTO_SYNC_INTERVAL_KEY]: "daily" });
    const server = createAccountSettingsServer();
    const getReply = held<ApiResponse<AccountSettings>>();
    server.get.mockReturnValueOnce(getReply.promise);
    const patchReply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(patchReply.promise);
    const sync = createSync(server);

    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(server.get).toHaveBeenCalled());
    const saving = sync.save("autoSyncInterval", "never");
    await vi.waitFor(() => expect(server.patch).toHaveBeenCalledTimes(1));

    // The GET reports an older server value while the save is still out.
    getReply.release({ data: { autoSyncInterval: "weekly" } });
    await expect(refreshing).resolves.toBe("followed");
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect((await stored())[AUTO_SYNC_INTERVAL_KEY]).toBe("daily");

    patchReply.release({ data: { autoSyncInterval: "never" } });
    await expect(saving).resolves.toBe("saved");
    expect((await stored())[AUTO_SYNC_INTERVAL_KEY]).toBe("never");
  });

  it.each([
    { name: "holds another value", record: { floatingIconSize: "large" } },
    { name: "holds no value", record: {} },
  ] as const)(
    "keeps a stored value written after the snapshot when the server $name",
    async ({ record }) => {
      await seed({ [FLOATING_ICON_SIZE_KEY]: "small" });
      const server = createAccountSettingsServer(record);
      const reply = held<ApiResponse<AccountSettings>>();
      server.get.mockReturnValueOnce(reply.promise);
      const sync = createSync(server);

      const refreshing = sync.refresh();
      await vi.waitFor(() => expect(server.get).toHaveBeenCalled());
      // Another tab or the options page writes the field while the GET is out.
      await chrome.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: "icon" });
      reply.release({ data: { ...record } });

      await expect(refreshing).resolves.toBe("followed");
      expect(server.patch).not.toHaveBeenCalled();
      expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("icon");
    },
  );

  it("never uploads the marker's older value after a save of the same field lands before the GET (R1)", async () => {
    // The options page left V1 (on); the Dialog saves V2 (off) before the open-time GET returns.
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      ...marker({ storePageChipEnabled: BoolFlag.TRUE }),
    });
    const server = createAccountSettingsServer();
    const getReply = held<ApiResponse<AccountSettings>>();
    server.get.mockReturnValueOnce(getReply.promise);
    const sync = createSync(server);

    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(server.get).toHaveBeenCalled());
    await expect(
      sync.save("storePageChipEnabled", BoolFlag.FALSE),
    ).resolves.toBe("saved");
    getReply.release({ data: {} });
    await expect(refreshing).resolves.toBe("followed");

    for (const [, body] of server.patch.mock.calls) {
      expect(body.settings?.storePageChipEnabled).not.toBe(BoolFlag.TRUE);
      expect(body.ifAbsent?.storePageChipEnabled).not.toBe(BoolFlag.TRUE);
    }
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(server.record.storePageChipEnabled).toBe(BoolFlag.FALSE);
    expect((await stored())[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.FALSE);
  });

  it("runs once per controller: a repeated call returns the same promise", async () => {
    const server = createAccountSettingsServer();
    const sync = createSync(server);

    const first = sync.refresh();
    const second = sync.refresh();

    expect(second).toBe(first);
    await first;
    expect(server.get).toHaveBeenCalledTimes(1);
  });
});

describe("AccountSettingsSync.save", () => {
  it("sends one field in settings, caches the confirmed value and clears an equal marker", async () => {
    await seed({
      [AUTO_SYNC_INTERVAL_KEY]: "daily",
      ...marker({ autoSyncInterval: "weekly" }),
    });
    const server = createAccountSettingsServer();
    const sync = createSync(server);

    await expect(sync.save("autoSyncInterval", "weekly")).resolves.toBe(
      "saved",
    );

    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(server.patch).toHaveBeenCalledWith(USER, {
      settings: { autoSyncInterval: "weekly" },
    });
    const after = await stored();
    expect(after[AUTO_SYNC_INTERVAL_KEY]).toBe("weekly");
    expect(after).not.toHaveProperty(ACCOUNT_SETTINGS_PENDING_KEY);
  });

  it("caches the value the server confirmed", async () => {
    const server = createAccountSettingsServer();
    server.patch.mockResolvedValueOnce({ data: { floatingIconSize: "icon" } });

    await expect(
      createSync(server).save("floatingIconSize", "large"),
    ).resolves.toBe("saved");

    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("icon");
  });

  it.each([
    {
      name: "an error envelope",
      reply: { error: { code: "INTERNAL_ERROR", message: "x" } },
    },
    { name: "a 429", reply: { error: { code: "RATE_LIMITED", message: "x" } } },
    { name: "an envelope without data", reply: {} },
  ])(
    "resolves failed on $name and writes nothing locally",
    async ({ reply }) => {
      await seed({ [SYNC_ARCHIVED_KEY]: BoolFlag.FALSE });
      const server = createAccountSettingsServer();
      server.patch.mockResolvedValueOnce(reply as ApiResponse<AccountSettings>);
      const sync = createSync(server);

      await expect(sync.save("syncArchived", BoolFlag.TRUE)).resolves.toBe(
        "failed",
      );

      expect(sync.isUnsupported()).toBe(false);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
      expect((await stored())[SYNC_ARCHIVED_KEY]).toBe(BoolFlag.FALSE);
    },
  );

  it("turns local-only on a 404 NOT_FOUND: writes the value and sends no later PATCH", async () => {
    const server = createAccountSettingsServer();
    server.patch.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const sync = createSync(server);
    const listener = vi.fn();
    sync.subscribe(listener);

    await expect(sync.save("syncArchived", BoolFlag.TRUE)).resolves.toBe(
      "localOnly",
    );
    expect(sync.isUnsupported()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((await stored())[SYNC_ARCHIVED_KEY]).toBe(BoolFlag.TRUE);

    await expect(sync.save("autoSyncInterval", "never")).resolves.toBe(
      "localOnly",
    );
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect((await stored())[AUTO_SYNC_INTERVAL_KEY]).toBe("never");
  });

  it("resolves stale and writes nothing when the endpoint changes while the PATCH is out", async () => {
    await seed({ [FLOATING_ICON_SIZE_KEY]: "small" });
    const server = createAccountSettingsServer();
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const sync = createSync(server);

    const saving = sync.save("floatingIconSize", "large");
    await vi.waitFor(() => expect(server.patch).toHaveBeenCalled());
    server.setEndpoint(OTHER_ENDPOINT);
    reply.release({ data: { floatingIconSize: "large" } });

    await expect(saving).resolves.toBe("stale");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("small");
  });

  it("resolves stale and sends nothing once disposed", async () => {
    const server = createAccountSettingsServer();
    const sync = createSync(server);
    sync.dispose();

    await expect(sync.save("syncArchived", BoolFlag.TRUE)).resolves.toBe(
      "stale",
    );
    expect(server.patch).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("keeps a stored value another writer changed while the PATCH was out", async () => {
    await seed({ [FLOATING_ICON_SIZE_KEY]: "small" });
    const server = createAccountSettingsServer();
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const sync = createSync(server);

    const saving = sync.save("floatingIconSize", "large");
    await vi.waitFor(() => expect(server.patch).toHaveBeenCalled());
    await chrome.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: "icon" });
    reply.release({ data: { floatingIconSize: "large" } });

    await expect(saving).resolves.toBe("saved");
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("icon");
  });

  it("keeps a marker the options page rewrote while the PATCH was out", async () => {
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });
    const server = createAccountSettingsServer();
    const reply = held<ApiResponse<AccountSettings>>();
    server.patch.mockReturnValueOnce(reply.promise);
    const sync = createSync(server);

    const saving = sync.save("storePageChipEnabled", BoolFlag.FALSE);
    await vi.waitFor(() => expect(server.patch).toHaveBeenCalled());
    // The options page turns the switch back on: local value + marker.
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    await writePendingAccountSetting("storePageChipEnabled", BoolFlag.TRUE);
    reply.release({ data: { storePageChipEnabled: BoolFlag.FALSE } });

    await expect(saving).resolves.toBe("saved");
    expect((await stored())[ACCOUNT_SETTINGS_PENDING_KEY]).toEqual(
      marker({ storePageChipEnabled: BoolFlag.TRUE })[
        ACCOUNT_SETTINGS_PENDING_KEY
      ],
    );
  });

  it("drops an older marker value of the field it saved, so the next open does not upload it", async () => {
    // A failed open-time upload left V1 (on) in the marker; the Dialog then saves V2 (off).
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
      ...marker({
        storePageChipEnabled: BoolFlag.TRUE,
        autoSyncInterval: "weekly",
      }),
    });
    const server = createAccountSettingsServer();
    const sync = createSync(server);

    await expect(
      sync.save("storePageChipEnabled", BoolFlag.FALSE),
    ).resolves.toBe("saved");

    // Only the saved field leaves the marker; the other pending field still goes up next open.
    expect((await stored())[ACCOUNT_SETTINGS_PENDING_KEY]).toEqual(
      marker({ autoSyncInterval: "weekly" })[ACCOUNT_SETTINGS_PENDING_KEY],
    );
    sync.dispose();
    await createSync(server).refresh();
    for (const [, body] of server.patch.mock.calls) {
      expect(body.settings?.storePageChipEnabled).not.toBe(BoolFlag.TRUE);
    }
    expect(server.record.storePageChipEnabled).toBe(BoolFlag.FALSE);
    expect((await stored())[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.FALSE);
  });
});

describe("AccountSettingsSync PATCH queue", () => {
  it("sends the next PATCH no sooner than ACCOUNT_SETTINGS_WRITE_GAP_MS after the previous reply", async () => {
    expect(ACCOUNT_SETTINGS_WRITE_GAP_MS).toBe(1100);
    vi.useFakeTimers();
    await seed({ [AUTO_SYNC_INTERVAL_KEY]: "weekly" });
    const server = createAccountSettingsServer();
    const sentAt: number[] = [];
    const contract = server.patch.getMockImplementation()!;
    server.patch.mockImplementation((userId, body) => {
      sentAt.push(Date.now());
      return contract(userId, body);
    });
    const sync = createSync(server);

    // The open-time fill is the first PATCH; a save made right after it must wait out the gap.
    await expect(sync.refresh()).resolves.toBe("followed");
    expect(server.patch).toHaveBeenCalledTimes(1);
    const saving = sync.save("syncArchived", BoolFlag.TRUE);

    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_GAP_MS - 1);
    expect(server.patch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.patch).toHaveBeenCalledTimes(2);
    await expect(saving).resolves.toBe("saved");
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(
      ACCOUNT_SETTINGS_WRITE_GAP_MS,
    );
  });

  it("measures the gap from the previous reply, not from its send", async () => {
    vi.useFakeTimers();
    await seed({ [AUTO_SYNC_INTERVAL_KEY]: "weekly" });
    const server = createAccountSettingsServer();
    const contract = server.patch.getMockImplementation()!;
    server.patch.mockImplementationOnce(async (userId, body) => {
      await new Promise((r) => setTimeout(r, 2000)); // slow first reply
      return contract(userId, body);
    });
    const sync = createSync(server);
    const refreshing = sync.refresh();
    await vi.advanceTimersByTimeAsync(10);
    const saving = sync.save("syncArchived", BoolFlag.TRUE);
    await vi.advanceTimersByTimeAsync(1990);
    await refreshing; // first reply landed at t = 2000
    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_GAP_MS - 1);
    expect(server.patch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.patch).toHaveBeenCalledTimes(2);
    await expect(saving).resolves.toBe("saved");
  });

  it("keeps a stored value written while a save waits out the gap", async () => {
    vi.useFakeTimers();
    await seed({
      [AUTO_SYNC_INTERVAL_KEY]: "weekly",
      [FLOATING_ICON_SIZE_KEY]: "small",
    });
    const server = createAccountSettingsServer({ floatingIconSize: "small" });
    const sync = createSync(server);
    await sync.refresh();
    expect(server.patch).toHaveBeenCalledTimes(1);

    const saving = sync.save("floatingIconSize", "large");
    await vi.advanceTimersByTimeAsync(10);
    await chrome.storage.local.set({ [FLOATING_ICON_SIZE_KEY]: "icon" });
    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_GAP_MS);

    await expect(saving).resolves.toBe("saved");
    expect(server.record.floatingIconSize).toBe("large");
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBe("icon");
  });

  it("resolves a save waiting out the gap as stale on dispose, sending nothing and leaving no timer", async () => {
    vi.useFakeTimers();
    await seed({ [AUTO_SYNC_INTERVAL_KEY]: "weekly" });
    const server = createAccountSettingsServer();
    const sync = createSync(server);
    await sync.refresh();

    const saving = sync.save("syncArchived", BoolFlag.TRUE);
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    sync.dispose();

    await expect(saving).resolves.toBe("stale");
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing and resolves stale when the endpoint changes while a save waits out the gap", async () => {
    vi.useFakeTimers();
    const server = createAccountSettingsServer();
    const sync = createSync(server);
    await expect(sync.save("syncArchived", BoolFlag.TRUE)).resolves.toBe(
      "saved",
    );
    vi.mocked(chrome.storage.local.set).mockClear();

    const saving = sync.save("floatingIconSize", "large");
    await vi.advanceTimersByTimeAsync(10);
    expect(server.patch).toHaveBeenCalledTimes(1);
    server.setEndpoint(OTHER_ENDPOINT);
    await vi.advanceTimersByTimeAsync(ACCOUNT_SETTINGS_WRITE_GAP_MS);

    await expect(saving).resolves.toBe("stale");
    expect(server.patch).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect((await stored())[FLOATING_ICON_SIZE_KEY]).toBeUndefined();
  });
});

describe("AccountSettingsSync never rejects", () => {
  it("resolves failed when the client has no accountSettings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      getEndpoint: () => "https://api.example.test",
    } as unknown as ApiClient;
    const sync = new AccountSettingsSync(client, USER);
    created.push(sync);

    await expect(sync.refresh()).resolves.toBe("failed");
    await expect(sync.save("syncArchived", BoolFlag.TRUE)).resolves.toBe(
      "failed",
    );
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("resolves failed when get / patch throw synchronously", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = createAccountSettingsServer();
    server.get.mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    server.patch.mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    const sync = createSync(server);

    await expect(sync.refresh()).resolves.toBe("failed");
    await expect(sync.save("autoSyncInterval", "never")).resolves.toBe(
      "failed",
    );
  });

  it("resolves failed when storage.local cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage unavailable"),
    );
    const server = createAccountSettingsServer();
    const sync = createSync(server);

    await expect(sync.refresh()).resolves.toBe("failed");
    await expect(sync.save("autoSyncInterval", "never")).resolves.toBe(
      "failed",
    );
  });
});

describe("AccountSettingsSync.whenSettled", () => {
  it("resolves at once when no refresh has started", async () => {
    const sync = createSync(createAccountSettingsServer());
    await expect(sync.whenSettled(5000)).resolves.toBeUndefined();
  });

  it("resolves only once the refresh settles", async () => {
    const server = createAccountSettingsServer();
    const reply = held<ApiResponse<AccountSettings>>();
    server.get.mockReturnValueOnce(reply.promise);
    const sync = createSync(server);

    const refreshing = sync.refresh();
    const settled = watch(sync.whenSettled(5000));
    await settle();
    expect(settled.done).toBe(false);

    reply.release({ data: {} });
    await refreshing;
    await settle();
    expect(settled.done).toBe(true);
  });

  it("resolves after the timeout when the refresh never settles, leaving no timer", async () => {
    vi.useFakeTimers();
    const server = createAccountSettingsServer();
    server.get.mockReturnValueOnce(new Promise(() => {}));
    const sync = createSync(server);

    void sync.refresh();
    const settled = watch(sync.whenSettled(5000));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves a pending wait on dispose", async () => {
    const server = createAccountSettingsServer();
    server.get.mockReturnValueOnce(new Promise(() => {}));
    const sync = createSync(server);

    void sync.refresh();
    const settled = watch(sync.whenSettled(60_000));
    sync.dispose();
    await settle();
    expect(settled.done).toBe(true);
  });

  it("stops notifying a listener once it unsubscribes", async () => {
    const server = createAccountSettingsServer();
    server.get.mockResolvedValueOnce({
      error: { code: "NOT_FOUND", message: "Not Found" },
    });
    const sync = createSync(server);
    const listener = vi.fn();
    const unsubscribe = sync.subscribe(listener);
    unsubscribe();

    await sync.refresh();
    expect(sync.isUnsupported()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
