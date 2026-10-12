import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readSyncArchived, writeSyncArchived } from "@/storage/syncArchived";
import { BoolFlag } from "@/api/client";
import { SYNC_ARCHIVED_KEY } from "@/constants";

/**
 * `readSyncArchived()` / `writeSyncArchived()` are the data-access layer for the
 * 同步封存書 flag. They talk to `browser.storage.local` directly (aliased to
 * `chrome.storage.local` in tests/setup.ts), never to the background (issue #308).
 * Reads follow the BoolFlag convention strictly: only an exact `BoolFlag.TRUE` (1)
 * reads as TRUE; a missing key, `true`, the string "1" or any other number reads as
 * FALSE, so a malformed value can never switch archive syncing on. Storage failures
 * propagate — the callers (the dialog hook, the sync step) decide the fallback.
 */
describe("readSyncArchived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [BoolFlag.TRUE, BoolFlag.TRUE],
    [BoolFlag.FALSE, BoolFlag.FALSE],
    [undefined, BoolFlag.FALSE], // key missing from the store
    [true, BoolFlag.FALSE], // raw boolean, not BoolFlag
    ["1", BoolFlag.FALSE], // string, not BoolFlag
    [2, BoolFlag.FALSE], // out-of-range number
    [null, BoolFlag.FALSE],
  ])("returns %o normalized to %s", async (stored, expected) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue(
      (stored === undefined ? {} : { [SYNC_ARCHIVED_KEY]: stored }) as never,
    );

    const result = await readSyncArchived();

    expect(result).toBe(expected);
    expect(chrome.storage.local.get).toHaveBeenCalledWith([SYNC_ARCHIVED_KEY]);
  });

  it("propagates the rejection when storage.local.get rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );

    await expect(readSyncArchived()).rejects.toThrow(
      "storage.local unavailable",
    );
  });
});

describe("writeSyncArchived", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([BoolFlag.TRUE, BoolFlag.FALSE])(
    "writes %s under the sync-archived key to storage.local only",
    async (value) => {
      await writeSyncArchived(value);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [SYNC_ARCHIVED_KEY]: value,
      });
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("propagates the rejection when storage.local.set rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );

    await expect(writeSyncArchived(BoolFlag.TRUE)).rejects.toThrow(
      "storage write failed",
    );
  });
});
