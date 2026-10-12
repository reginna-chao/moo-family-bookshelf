import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_AUTO_SYNC_INTERVAL,
  isAutoSyncInterval,
  readAutoSyncInterval,
  writeAutoSyncInterval,
} from "@/storage/autoSyncInterval";
import { AUTO_SYNC_INTERVAL_KEY } from "@/constants";

/**
 * `readAutoSyncInterval()` / `writeAutoSyncInterval()` are the data-access layer
 * for the auto-sync frequency. They talk to `browser.storage.local` directly
 * (aliased to `chrome.storage.local` in tests/setup.ts), never to the background.
 * Reads accept only the four exact options; everything else — missing key, wrong
 * type, wrong case — reads as the default "daily".
 */
describe("isAutoSyncInterval", () => {
  it.each([
    ["daily", true],
    ["weekly", true],
    ["monthly", true],
    ["never", true],
    ["yearly", false],
    ["NEVER", false],
    ["", false],
    [undefined, false],
    [null, false],
    [0, false],
  ])("returns %s for %o", (value, expected) => {
    expect(isAutoSyncInterval(value)).toBe(expected);
  });
});

describe("readAutoSyncInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses 'daily' as the default", () => {
    expect(DEFAULT_AUTO_SYNC_INTERVAL).toBe("daily");
  });

  it.each([
    ["daily", "daily"],
    ["weekly", "weekly"],
    ["monthly", "monthly"],
    ["never", "never"],
    [undefined, "daily"], // key missing from the store
    ["yearly", "daily"], // unknown string
    ["Never", "daily"], // case-sensitive
    ["", "daily"], // empty string
    [7, "daily"], // wrong type: number
    [null, "daily"], // wrong type: null
    [{ interval: "never" }, "daily"], // wrong type: object
  ])("returns %o normalized to '%s'", async (stored, expected) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue(
      (stored === undefined
        ? {}
        : { [AUTO_SYNC_INTERVAL_KEY]: stored }) as never,
    );

    const result = await readAutoSyncInterval();

    expect(result).toBe(expected);
    expect(chrome.storage.local.get).toHaveBeenCalledWith([
      AUTO_SYNC_INTERVAL_KEY,
    ]);
  });

  it("propagates the rejection when storage.local.get rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );

    await expect(readAutoSyncInterval()).rejects.toThrow(
      "storage.local unavailable",
    );
  });
});

describe("writeAutoSyncInterval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["daily", "weekly", "monthly", "never"] as const)(
    "writes '%s' under the auto-sync key to storage.local only",
    async (interval) => {
      await writeAutoSyncInterval(interval);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [AUTO_SYNC_INTERVAL_KEY]: interval,
      });
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("propagates the rejection when storage.local.set rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );

    await expect(writeAutoSyncInterval("never")).rejects.toThrow(
      "storage write failed",
    );
  });
});
