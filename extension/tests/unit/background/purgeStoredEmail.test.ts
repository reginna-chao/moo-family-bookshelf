import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { purgeStoredEmail } from "@/background/purgeStoredEmail";
import { USER_EMAIL_KEY, DISPLAY_NAME_KEY } from "@/constants";

/**
 * purgeStoredEmail (#359): the Extension no longer stores the Readmoo email;
 * this removes what older versions left behind, under both the prefixed key
 * and the legacy unprefixed one, in a single storage call.
 *
 * Runs against the setup.ts storage mock (one shared store, `chrome` and
 * `browser` alias the same spies). The rejection case swaps in a one-shot
 * rejected `remove`; the purge is best-effort and must never reject.
 * Wiring into `runtime.onInstalled`: tests/unit/background.test.ts.
 */

// Legacy unprefixed key, not exported by production (pre-June-2026 installs).
const LEGACY_USER_EMAIL_KEY = "userEmail";

describe("purgeStoredEmail", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  it("removes both email keys in one storage call and keeps other data", async () => {
    await chrome.storage.local.set({
      [USER_EMAIL_KEY]: "old@example.com",
      [LEGACY_USER_EMAIL_KEY]: "legacy@example.com",
      [DISPLAY_NAME_KEY]: "Owner",
    });

    await purgeStoredEmail();

    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([
      USER_EMAIL_KEY,
      LEGACY_USER_EMAIL_KEY,
    ]);
    const stored = await chrome.storage.local.get(null);
    expect(stored).toEqual({ [DISPLAY_NAME_KEY]: "Owner" });
  });

  it("resolves and warns when storage.local.remove rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    try {
      await expect(purgeStoredEmail()).resolves.toBeUndefined();

      expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        "[Background] storage.local.remove failed for stored email",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when the removal succeeds (positive companion)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await purgeStoredEmail();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
