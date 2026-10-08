import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient } from "@/api/client";
import { useLeaveFamily } from "@/hooks/useLeaveFamily";
import { rateLimitedEnvelopeMessage } from "@/utils/retryMessage";
import {
  isSelfDepartureActive,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";

/**
 * useLeaveFamily — the PWA's own "leave family" flow, sent through
 * `runGuardedDeparture` (#263) so a 401 raised while the leave is in flight
 * cannot trigger a silent recovery join that re-adds the user. The outcomes
 * and copy are the pre-#263 ones; what this file adds is that the departure
 * mark is up while the request and its settling run, and gone afterwards in
 * every branch. Twin: `extension/tests/unit/dialog/useFamilySettingsLeave.test.ts`.
 */

type LeaveRes = ApiResponse<{ ok: boolean }>;

const USER_ID = "a".repeat(64);

function setup(leaveFamily: () => Promise<LeaveRes>) {
  /** Was the departure mark up when the request went out / when settling? */
  const seen = { send: [] as boolean[], settle: [] as boolean[] };
  // vi.fn records the call's arguments even though this body ignores them.
  const leave = vi.fn(async () => {
    seen.send.push(isSelfDepartureActive());
    return leaveFamily();
  });
  const onLogout = vi.fn(() => {
    seen.settle.push(isSelfDepartureActive());
  });
  const apiClient = { leaveFamily: leave } as unknown as ApiClient;
  const hook = renderHook(() =>
    useLeaveFamily({ familyId: "fam-1", userId: USER_ID, apiClient, onLogout }),
  );
  return { hook, leave, onLogout, seen };
}

async function leave(hook: ReturnType<typeof setup>["hook"]) {
  await act(async () => {
    await hook.result.current.handleLeave();
  });
}

describe("useLeaveFamily", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it("logs out on success, with the departure mark up for the request and the logout", async () => {
    const {
      hook,
      leave: send,
      onLogout,
      seen,
    } = setup(async () => ({
      data: { ok: true },
    }));

    await leave(hook);

    expect(send).toHaveBeenCalledWith("fam-1", USER_ID);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ send: [true], settle: [true] });
    expect(hook.result.current.leaveError).toBeNull();
    expect(isSelfDepartureActive()).toBe(false);
  });

  // Self-leave: both codes mean nothing is left to leave; keeping the session would
  // let recovery re-join (or strand the user on a dead family).
  it.each(["MEMBER_NOT_FOUND", "FAMILY_NOT_FOUND"])(
    "treats %s as already left and logs out",
    async (code) => {
      const { hook, onLogout } = setup(async () => ({
        error: { code, message: "stub" },
      }));

      await leave(hook);

      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(hook.result.current.leaveError).toBeNull();
      expect(isSelfDepartureActive()).toBe(false);
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
    "stays logged in and shows the copy for %s",
    async (_label, res, expected) => {
      const { hook, onLogout } = setup(async () => res);

      await leave(hook);

      expect(onLogout).not.toHaveBeenCalled();
      expect(hook.result.current.leaveError).toBe(expected);
      expect(hook.result.current.leaveState).toBe("idle");
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  it("shows the localized back-off copy for a 429, not the server's message", async () => {
    const { hook } = setup(async () => ({
      error: { code: "RATE_LIMITED", message: "Too Many Requests" },
    }));

    await leave(hook);

    // Static variant (no retryAfter) — pinned in tests/unit/retryMessage.test.ts.
    expect(hook.result.current.leaveError).toBe("嘗試次數過多，請稍後再試。");
  });

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "離開失敗"],
  ])(
    "shows an error and clears the mark when the request throws %s",
    async (_label, thrown, expected) => {
      const { hook, onLogout } = setup(async () => {
        throw thrown;
      });

      await leave(hook);

      expect(onLogout).not.toHaveBeenCalled();
      expect(hook.result.current.leaveError).toBe(expected);
      expect(hook.result.current.leaveState).toBe("idle");
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  // Token replaced elsewhere: the mark blocked recovery, so the guarded send gets a
  // 401; it is resent once with the mark lifted, and the user still ends logged out.
  it("resends once after its own 401 and ends logged out", async () => {
    const responses: LeaveRes[] = [
      { error: { code: "UNAUTHORIZED", message: "revoked" } },
      { data: { ok: true } },
    ];
    const {
      hook,
      leave: send,
      onLogout,
      seen,
    } = setup(async () => responses.shift()!);

    await leave(hook);

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(seen.settle).toEqual([true]);
    expect(isSelfDepartureActive()).toBe(false);
  });

  it("shows an error, not a logout, when the resend is refused again", async () => {
    const {
      hook,
      leave: send,
      onLogout,
    } = setup(async () => ({
      error: { code: "UNAUTHORIZED", message: "請重新登入" },
    }));

    await leave(hook);

    expect(send).toHaveBeenCalledTimes(2);
    expect(onLogout).not.toHaveBeenCalled();
    expect(hook.result.current.leaveError).toBe("請重新登入");
    expect(isSelfDepartureActive()).toBe(false);
  });
});
