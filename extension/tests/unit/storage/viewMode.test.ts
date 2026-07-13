import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readFamilyShelfViewMode,
  writeFamilyShelfViewMode,
} from "@/storage/viewMode";
import { FAMILY_SHELF_VIEW_MODE_KEY } from "@/constants";

/**
 * `readFamilyShelfViewMode()` / `writeFamilyShelfViewMode()` are the data-access
 * layer for the Family Shelf view mode. They talk to `browser.storage.local`
 * directly (aliased to `chrome.storage.local` in tests/setup.ts). Reads
 * normalize to "row" ONLY when the stored value is exactly the string "row",
 * everything else — missing key, wrong type, wrong case — is "grid"
 * (default-closed to the grid layout).
 */
describe("readFamilyShelfViewMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["row", "row"],
    ["grid", "grid"],
    [undefined, "grid"], // key missing from the store
    ["list", "grid"], // unknown string
    ["ROW", "grid"], // case-sensitive: not exactly "row"
    ["", "grid"], // empty string
    [42, "grid"], // wrong type: number
    [null, "grid"], // wrong type: null
    [true, "grid"], // wrong type: boolean
    [{ mode: "row" }, "grid"], // wrong type: object
  ])("returns %o normalized to '%s'", async (stored, expected) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue(
      (stored === undefined
        ? {}
        : { [FAMILY_SHELF_VIEW_MODE_KEY]: stored }) as never,
    );

    const result = await readFamilyShelfViewMode();

    expect(result).toBe(expected);
    expect(chrome.storage.local.get).toHaveBeenCalledWith([
      FAMILY_SHELF_VIEW_MODE_KEY,
    ]);
  });

  it("propagates the rejection when storage.local.get rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );

    await expect(readFamilyShelfViewMode()).rejects.toThrow(
      "storage.local unavailable",
    );
  });
});

describe("writeFamilyShelfViewMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["grid", "row"] as const)(
    "writes '%s' under the view-mode key to storage.local",
    async (mode) => {
      await writeFamilyShelfViewMode(mode);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [FAMILY_SHELF_VIEW_MODE_KEY]: mode,
      });
    },
  );

  it("propagates the rejection when storage.local.set rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );

    await expect(writeFamilyShelfViewMode("row")).rejects.toThrow(
      "storage write failed",
    );
  });
});
