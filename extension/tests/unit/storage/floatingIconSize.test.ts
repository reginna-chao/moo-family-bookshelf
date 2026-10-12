import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_FLOATING_ICON_SIZE,
  isFloatingIconSize,
  readFloatingIconSize,
  writeFloatingIconSize,
} from "@/storage/floatingIconSize";
import { FLOATING_ICON_SIZE_KEY } from "@/constants";

/**
 * `readFloatingIconSize()` / `writeFloatingIconSize()` are the data-access layer for
 * the floating-button size, shared by the dialog hook and the content script. They
 * talk to `browser.storage.local` directly (aliased to `chrome.storage.local` in
 * tests/setup.ts), never to the background (issue #308). Reads accept only the four
 * exact options; everything else — missing key, wrong type, wrong case — reads as
 * the default "medium".
 */
describe("isFloatingIconSize", () => {
  it.each([
    ["small", true],
    ["medium", true],
    ["large", true],
    ["icon", true],
    ["huge", false],
    ["LARGE", false],
    ["", false],
    [undefined, false],
    [null, false],
    [42, false],
  ])("returns %s for %o", (value, expected) => {
    expect(isFloatingIconSize(value)).toBe(expected);
  });
});

describe("readFloatingIconSize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses 'medium' as the default", () => {
    expect(DEFAULT_FLOATING_ICON_SIZE).toBe("medium");
  });

  it.each([
    ["small", "small"],
    ["medium", "medium"],
    ["large", "large"],
    ["icon", "icon"],
    [undefined, "medium"], // key missing from the store
    ["huge", "medium"], // unknown string
    ["Large", "medium"], // case-sensitive
    ["", "medium"], // empty string
    [3, "medium"], // wrong type: number
    [null, "medium"], // wrong type: null
    [{ size: "large" }, "medium"], // wrong type: object
  ])("returns %o normalized to '%s'", async (stored, expected) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue(
      (stored === undefined
        ? {}
        : { [FLOATING_ICON_SIZE_KEY]: stored }) as never,
    );

    const result = await readFloatingIconSize();

    expect(result).toBe(expected);
    expect(chrome.storage.local.get).toHaveBeenCalledWith([
      FLOATING_ICON_SIZE_KEY,
    ]);
  });

  it("propagates the rejection when storage.local.get rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );

    await expect(readFloatingIconSize()).rejects.toThrow(
      "storage.local unavailable",
    );
  });
});

describe("writeFloatingIconSize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["small", "medium", "large", "icon"] as const)(
    "writes '%s' under the floating-icon-size key to storage.local only",
    async (size) => {
      await writeFloatingIconSize(size);

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [FLOATING_ICON_SIZE_KEY]: size,
      });
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("propagates the rejection when storage.local.set rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );

    await expect(writeFloatingIconSize("large")).rejects.toThrow(
      "storage write failed",
    );
  });
});
