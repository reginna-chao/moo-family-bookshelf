import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { ApiResponse } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY, USER_ID_KEY } from "@/constants";
import { useFamilySettingsDelete } from "@/dialog/useFamilySettingsDelete";
import { isSelfDepartureActive } from "@/storage/selfDeparture";

/**
 * useFamilySettingsDelete — the dialog's own "delete account" flow, sent
 * through `runGuardedDeparture` (#263) so a 401 raised while the deletion is in
 * flight cannot trigger a silent recovery join that re-adds the user. On
 * success it still wipes `browser.storage.local` (which takes the departure
 * mark with it) before `onLeave`; outcomes and copy are unchanged. Twin:
 * `pwa/tests/unit/hooks/useDeleteAccount.test.ts`.
 */

type DeleteRes = ApiResponse<{ ok: boolean }>;

function setup(deleteAccount: () => Promise<DeleteRes>) {
  const seen = { send: [] as boolean[] };
  // vi.fn records the call's arguments even though this body ignores them.
  const send = vi.fn(async () => {
    seen.send.push(await isSelfDepartureActive());
    return deleteAccount();
  });
  const onLeave = vi.fn();
  const apiClient = { deleteAccount: send } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsDelete({ userId: "user-1", apiClient, onLeave }),
  );
  const confirmDelete = async () => {
    await act(async () => {
      await hook.result.current.handleDeleteConfirm();
    });
  };
  return { hook, send, onLeave, seen, confirmDelete };
}

describe("useFamilySettingsDelete", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [USER_ID_KEY]: "user-1" });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("clears local storage while still guarded, then calls onLeave", async () => {
    const { send, onLeave, seen, confirmDelete } = setup(async () => ({
      data: { ok: true },
    }));
    // The wipe is the settle step's own work, so it must run under the mark.
    let markedDuringClear: boolean | undefined;
    const clear = vi.mocked(chrome.storage.local.clear);
    const storeClear = clear.getMockImplementation() as () => Promise<void>;
    clear.mockImplementationOnce((async () => {
      const stored = await chrome.storage.local.get(SELF_DEPARTURE_UNTIL_KEY);
      markedDuringClear = typeof stored[SELF_DEPARTURE_UNTIL_KEY] === "number";
      await storeClear();
    }) as never);

    await confirmDelete();

    expect(send).toHaveBeenCalledWith("user-1");
    expect(seen.send).toEqual([true]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(markedDuringClear).toBe(true);
    expect(onLeave).toHaveBeenCalledTimes(1);
    // Storage wiped, mark included — the cleanup found nothing left to remove.
    expect(await chrome.storage.local.get(null)).toEqual({});
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it("still calls onLeave when the local clear fails, and leaves no mark behind", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(chrome.storage.local.clear).mockRejectedValueOnce(
      new Error("Extension context invalidated"),
    );
    const { hook, onLeave, confirmDelete } = setup(async () => ({
      data: { ok: true },
    }));

    await confirmDelete();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it.each<[string, DeleteRes, string]>([
    [
      "OWNER_CANNOT_DELETE",
      { error: { code: "OWNER_CANNOT_DELETE", message: "owner" } },
      "管理者必須先轉移管理權才能移除帳戶",
    ],
    [
      "a server message",
      { error: { code: "SERVER_ERROR", message: "伺服器忙碌" } },
      "伺服器忙碌",
    ],
    [
      "an empty server message",
      { error: { code: "SERVER_ERROR", message: "" } },
      "移除帳戶失敗，請稍後再試",
    ],
  ])(
    "keeps the account and shows the copy for %s",
    async (_label, res, expected) => {
      const { hook, onLeave, confirmDelete } = setup(async () => res);

      await confirmDelete();

      expect(onLeave).not.toHaveBeenCalled();
      expect(chrome.storage.local.clear).not.toHaveBeenCalled();
      expect(hook.result.current.deleteError).toBe(expected);
      expect(hook.result.current.deleteState).toBe("idle");
      expect(await isSelfDepartureActive()).toBe(false);
      // Local data survives a refused deletion.
      expect((await chrome.storage.local.get(USER_ID_KEY))[USER_ID_KEY]).toBe(
        "user-1",
      );
    },
  );

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "發生未知錯誤"],
  ])(
    "shows an error and clears the mark when the request throws %s",
    async (_label, thrown, expected) => {
      const { hook, onLeave, confirmDelete } = setup(async () => {
        throw thrown;
      });

      await confirmDelete();

      expect(onLeave).not.toHaveBeenCalled();
      expect(hook.result.current.deleteError).toBe(expected);
      expect(hook.result.current.deleteState).toBe("idle");
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it("resends once after its own 401 and still deletes", async () => {
    const responses: DeleteRes[] = [
      { error: { code: "UNAUTHORIZED", message: "revoked" } },
      { data: { ok: true } },
    ];
    const { send, onLeave, seen, confirmDelete } = setup(async () =>
      responses.shift()!,
    );

    await confirmDelete();

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(await isSelfDepartureActive()).toBe(false);
  });
});
