import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { API_ENDPOINT_KEY, FAMILY_ID_KEY, USER_ID_KEY } from "@/constants";
import { departureBindingIsCurrent } from "@/dialog/departureBinding";

/**
 * departureBindingIsCurrent — the check a leave / delete runs when its success lands: does storage
 * still bind the account and family the request was sent for? Only the stored userId + familyId are
 * compared; the stored server is deliberately not (a confirmed endpoint switch keeps the familyId,
 * and leaving that family is what the user asked for). It is false only when storage binds ANOTHER
 * account or family. A family binding that is gone (another tab already left or was removed) with
 * no account or the same account stored is true: there is no other session to keep, and the caller
 * must still clear (a deleted account's cache must not stay behind). A stored family with no account
 * is false. A storage read that throws is true, so a completed leave or a deleted account is never
 * stuck on a read that failed.
 */

const BINDING = { userId: "user-1", familyId: "fam-1" };

describe("departureBindingIsCurrent", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    [
      "the same account and family",
      { [USER_ID_KEY]: "user-1", [FAMILY_ID_KEY]: "fam-1" },
      true,
    ],
    [
      "the same account and family on another server",
      {
        [USER_ID_KEY]: "user-1",
        [FAMILY_ID_KEY]: "fam-1",
        [API_ENDPOINT_KEY]: "https://self-hosted.example",
      },
      true,
    ],
    [
      "another family",
      { [USER_ID_KEY]: "user-1", [FAMILY_ID_KEY]: "fam-2" },
      false,
    ],
    [
      "another account",
      { [USER_ID_KEY]: "user-2", [FAMILY_ID_KEY]: "fam-1" },
      false,
    ],
    [
      "another account and family",
      { [USER_ID_KEY]: "user-2", [FAMILY_ID_KEY]: "fam-2" },
      false,
    ],
    ["no family any more", { [USER_ID_KEY]: "user-1" }, true],
    ["nothing stored", {}, true],
    [
      "no family any more under another account",
      { [USER_ID_KEY]: "user-2" },
      false,
    ],
    ["no account any more", { [FAMILY_ID_KEY]: "fam-1" }, false],
  ])("for %s, returns %s", async (_label, stored, expected) => {
    await chrome.storage.local.set(stored);

    await expect(departureBindingIsCurrent(BINDING)).resolves.toBe(expected);
  });

  it("returns true when the storage read rejects", async () => {
    await chrome.storage.local.set({
      [USER_ID_KEY]: "user-2",
      [FAMILY_ID_KEY]: "fam-2",
    });
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("Extension context invalidated"),
    );

    await expect(departureBindingIsCurrent(BINDING)).resolves.toBe(true);
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
  });

  it("does not change storage", async () => {
    const stored = { [USER_ID_KEY]: "user-2", [FAMILY_ID_KEY]: "fam-2" };
    await chrome.storage.local.set(stored);

    await departureBindingIsCurrent(BINDING);

    expect(await chrome.storage.local.get(null)).toEqual(stored);
  });
});
