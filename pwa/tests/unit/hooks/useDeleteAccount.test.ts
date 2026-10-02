import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient } from "@/api/client";
import { useDeleteAccount } from "@/hooks/useDeleteAccount";
import {
  isSelfDepartureActive,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";

/**
 * useDeleteAccount — the PWA's own "delete account" flow, sent through
 * `runGuardedDeparture` (#263) so a 401 raised while the deletion is in flight
 * cannot trigger a silent recovery join that re-adds the user. Outcomes and
 * copy are unchanged; the mark is up for the request and the force-logout, and
 * gone afterwards in every branch. Twin:
 * `extension/tests/unit/dialog/useFamilySettingsDelete.test.ts`.
 */

type DeleteRes = ApiResponse<{ ok: boolean }>;

const USER_ID = "a".repeat(64);

function setup(deleteAccount: () => Promise<DeleteRes>) {
  const seen = { send: [] as boolean[], settle: [] as boolean[] };
  // vi.fn records the call's arguments even though this body ignores them.
  const send = vi.fn(async () => {
    seen.send.push(isSelfDepartureActive());
    return deleteAccount();
  });
  const onForceLogout = vi.fn(() => {
    seen.settle.push(isSelfDepartureActive());
  });
  const apiClient = { deleteAccount: send } as unknown as ApiClient;
  const hook = renderHook(() =>
    useDeleteAccount({ userId: USER_ID, apiClient, onForceLogout }),
  );
  return { hook, send, onForceLogout, seen };
}

async function confirmDelete(hook: ReturnType<typeof setup>["hook"]) {
  await act(async () => {
    await hook.result.current.handleDeleteAccount();
  });
}

describe("useDeleteAccount", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it("force-logs out on success, with the departure mark up for the request and the logout", async () => {
    const { hook, send, onForceLogout, seen } = setup(async () => ({
      data: { ok: true },
    }));

    await confirmDelete(hook);

    expect(send).toHaveBeenCalledWith(USER_ID);
    expect(onForceLogout).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ send: [true], settle: [true] });
    expect(hook.result.current.deleteError).toBeNull();
    expect(isSelfDepartureActive()).toBe(false);
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
    "stays logged in and shows the copy for %s",
    async (_label, res, expected) => {
      const { hook, onForceLogout } = setup(async () => res);

      await confirmDelete(hook);

      expect(onForceLogout).not.toHaveBeenCalled();
      expect(hook.result.current.deleteError).toBe(expected);
      expect(hook.result.current.deleteState).toBe("idle");
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "移除失敗"],
  ])(
    "shows an error and clears the mark when the request throws %s",
    async (_label, thrown, expected) => {
      const { hook, onForceLogout } = setup(async () => {
        throw thrown;
      });

      await confirmDelete(hook);

      expect(onForceLogout).not.toHaveBeenCalled();
      expect(hook.result.current.deleteError).toBe(expected);
      expect(hook.result.current.deleteState).toBe("idle");
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  it("resends once after its own 401 and ends logged out", async () => {
    const responses: DeleteRes[] = [
      { error: { code: "UNAUTHORIZED", message: "revoked" } },
      { data: { ok: true } },
    ];
    const { hook, send, onForceLogout, seen } = setup(async () =>
      responses.shift()!,
    );

    await confirmDelete(hook);

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(onForceLogout).toHaveBeenCalledTimes(1);
    expect(seen.settle).toEqual([true]);
    expect(isSelfDepartureActive()).toBe(false);
  });
});
