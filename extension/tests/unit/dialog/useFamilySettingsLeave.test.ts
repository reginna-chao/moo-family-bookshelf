import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { ApiResponse } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/constants";
import { useFamilySettingsLeave } from "@/dialog/useFamilySettingsLeave";
import { rateLimitedEnvelopeMessage } from "@/dialog/verificationMessages";
import { isSelfDepartureActive } from "@/storage/selfDeparture";

/**
 * useFamilySettingsLeave — the dialog's own "leave family" flow, sent through
 * `runGuardedDeparture` (#263) so a 401 raised while the leave is in flight
 * cannot trigger `doRefreshToken`'s silent recovery join and re-add the user.
 * The outcomes and copy are the pre-#263 ones; what this file adds is that the
 * departure mark is up while the request and its settling run, and gone
 * afterwards in every branch. Twin: `pwa/tests/unit/hooks/useLeaveFamily.test.ts`.
 */

type LeaveRes = ApiResponse<{ ok: boolean }>;

function setup(leaveFamily: () => Promise<LeaveRes>) {
  /** Was the departure mark up when the request went out / when settling? */
  const seen = { send: [] as boolean[], settle: [] as boolean[] };
  // vi.fn records the call's arguments even though this body ignores them.
  const send = vi.fn(async () => {
    seen.send.push(await isSelfDepartureActive());
    return leaveFamily();
  });
  // onLeave is synchronous; record the mark through a promise awaited below.
  const settleChecks: Array<Promise<void>> = [];
  const onLeave = vi.fn(() => {
    settleChecks.push(
      isSelfDepartureActive().then((active) => {
        seen.settle.push(active);
      }),
    );
  });
  const apiClient = { leaveFamily: send } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsLeave({
      familyId: "fam-1",
      userId: "user-1",
      apiClient,
      onLeave,
    }),
  );
  const confirmLeave = async () => {
    await act(async () => {
      await hook.result.current.handleLeaveConfirm();
    });
    await Promise.all(settleChecks);
  };
  return { hook, send, onLeave, seen, confirmLeave };
}

describe("useFamilySettingsLeave", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("calls onLeave on success, with the departure mark up for the request and onLeave", async () => {
    const { hook, send, onLeave, seen, confirmLeave } = setup(async () => ({
      data: { ok: true },
    }));

    await confirmLeave();

    expect(send).toHaveBeenCalledWith("fam-1", "user-1");
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ send: [true], settle: [true] });
    expect(hook.result.current.leaveError).toBe("");
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it.each(["MEMBER_NOT_FOUND", "FAMILY_NOT_FOUND"])(
    "treats %s as already left and calls onLeave",
    async (code) => {
      const { hook, onLeave, confirmLeave } = setup(async () => ({
        error: { code, message: "stub" },
      }));

      await confirmLeave();

      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(hook.result.current.leaveError).toBe("");
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it.each<[string, LeaveRes, string]>([
    [
      "OWNER_CANNOT_LEAVE",
      { error: { code: "OWNER_CANNOT_LEAVE", message: "owner" } },
      "管理者必須先轉移管理權才能離開家庭",
    ],
    [
      "RATE_LIMITED with a wait",
      { error: { code: "RATE_LIMITED", message: "slow down", retryAfter: 45 } },
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter: 45 })!,
    ],
    [
      "RATE_LIMITED without a wait",
      { error: { code: "RATE_LIMITED", message: "Too Many Requests" } },
      // Pinned in tests/unit/dialog/verificationMessages.test.ts.
      "嘗試次數過多，請稍後再試",
    ],
    [
      "a server message",
      { error: { code: "SERVER_ERROR", message: "伺服器忙碌" } },
      "伺服器忙碌",
    ],
    [
      "an empty server message",
      { error: { code: "SERVER_ERROR", message: "" } },
      "離開家庭失敗，請稍後再試",
    ],
  ])(
    "keeps the family and shows the copy for %s",
    async (_label, res, expected) => {
      const { hook, onLeave, confirmLeave } = setup(async () => res);

      await confirmLeave();

      expect(onLeave).not.toHaveBeenCalled();
      expect(hook.result.current.leaveError).toBe(expected);
      expect(hook.result.current.leaveState).toBe("idle");
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "發生未知錯誤"],
  ])(
    "shows an error and clears the mark when the request throws %s",
    async (_label, thrown, expected) => {
      const { hook, onLeave, confirmLeave } = setup(async () => {
        throw thrown;
      });

      await confirmLeave();

      expect(onLeave).not.toHaveBeenCalled();
      expect(hook.result.current.leaveError).toBe(expected);
      expect(hook.result.current.leaveState).toBe("idle");
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it("resends once after its own 401 and still leaves", async () => {
    const responses: LeaveRes[] = [
      { error: { code: "UNAUTHORIZED", message: "revoked" } },
      { data: { ok: true } },
    ];
    const { send, onLeave, seen, confirmLeave } = setup(async () =>
      responses.shift()!,
    );

    await confirmLeave();

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(seen.settle).toEqual([true]);
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it("shows an error, not a leave, when the resend is refused again", async () => {
    const { hook, send, onLeave, confirmLeave } = setup(async () => ({
      error: { code: "UNAUTHORIZED", message: "請重新驗證" },
    }));

    await confirmLeave();

    expect(send).toHaveBeenCalledTimes(2);
    expect(onLeave).not.toHaveBeenCalled();
    expect(hook.result.current.leaveError).toBe("請重新驗證");
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it("removes the mark key from storage by the time it returns", async () => {
    const { confirmLeave } = setup(async () => ({ data: { ok: true } }));

    await confirmLeave();

    const stored = await chrome.storage.local.get(SELF_DEPARTURE_UNTIL_KEY);
    expect(stored).toEqual({});
  });
});
