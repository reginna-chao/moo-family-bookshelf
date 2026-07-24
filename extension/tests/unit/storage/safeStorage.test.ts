import { describe, it, expect, vi, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { safeStorageGet } from "@/storage/safeStorage";

/**
 * `safeStorageGet(keys)` is a best-effort READ helper that shields callers from
 * the "Extension context invalidated" rejection an orphaned content script hits
 * after the extension reloads. Its contract has three branches:
 *
 *   1. context invalid  → return `{}` WITHOUT touching `browser.storage.local`.
 *   2. context valid     → pass the keys through and return the raw result.
 *   3. `.get(...)` throws → swallow the error and return `{}`.
 *
 * `isExtensionContextValid()` (the real internal util — NOT mocked, per mock
 * policy) decides branch 1 by reading `browser.runtime.id`. tests/setup.ts sets
 * that id, so the context is valid by default; branch 1 is exercised by
 * temporarily clearing the id and restoring it afterwards.
 */

const runtime = browser.runtime as { id?: string };
const ORIGINAL_RUNTIME_ID = runtime.id;

describe("safeStorageGet", () => {
  afterEach(() => {
    // Restore the shared runtime.id + storage spy so sibling suites keep a valid
    // context and an un-stubbed `browser.storage.local.get`.
    runtime.id = ORIGINAL_RUNTIME_ID;
    vi.restoreAllMocks();
    vi.mocked(browser.storage.local.get).mockClear();
  });

  it("returns the storage result verbatim when the extension context is valid", async () => {
    const stored = { displayName: "小明", count: 3 };
    const getSpy = vi
      .spyOn(browser.storage.local, "get")
      .mockResolvedValue(stored as never);

    const result = await safeStorageGet(["displayName", "count"]);

    expect(getSpy).toHaveBeenCalledWith(["displayName", "count"]);
    expect(result).toEqual(stored);
  });

  it("forwards a single string key to storage.get", async () => {
    const getSpy = vi
      .spyOn(browser.storage.local, "get")
      .mockResolvedValue({ token: "abc" } as never);

    const result = await safeStorageGet("token");

    expect(getSpy).toHaveBeenCalledWith("token");
    expect(result).toEqual({ token: "abc" });
  });

  it("returns an empty object and skips storage.get when the context is invalid", async () => {
    // Simulate an orphaned content script: runtime.id is gone, so
    // isExtensionContextValid() reports false.
    runtime.id = undefined;
    const getSpy = vi.spyOn(browser.storage.local, "get");

    const result = await safeStorageGet(["displayName"]);

    expect(result).toEqual({});
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("returns an empty object when storage.get throws mid-read", async () => {
    // Context passes the initial check but the read still fails (invalidated
    // between check and call) — the rejection must be swallowed, not surfaced.
    const getSpy = vi
      .spyOn(browser.storage.local, "get")
      .mockRejectedValue(new Error("Extension context invalidated"));

    const result = await safeStorageGet(["displayName"]);

    expect(getSpy).toHaveBeenCalledWith(["displayName"]);
    expect(result).toEqual({});
  });
});
