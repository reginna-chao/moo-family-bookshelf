import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { useLeaveFamily } from "@/hooks/useLeaveFamily";
import {
  buildRetryMessage,
  rateLimitedEnvelopeMessage,
} from "@/utils/retryMessage";
import {
  isSelfDepartureActive,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";
import { expectSecretNotStored } from "../../helpers/secretStorage";

/**
 * useLeaveFamily — the PWA's own "leave family" flow, sent through
 * `runGuardedDeparture` (#263) so a 401 raised while the leave is in flight
 * cannot trigger a silent recovery join that re-adds the user. The outcomes
 * and copy are the pre-#263 ones; what this file adds is that the departure
 * mark is up while the request and its settling run, and gone afterwards in
 * every branch. Twin: `extension/tests/unit/dialog/useFamilySettingsLeave.test.ts`.
 *
 * Current-secret step: `startConfirming` reads the verify method once and opens the confirm step
 * with `requiredMethod` set (null when the read failed: no secret is asked, the server decides). A
 * PIN / pattern account sends its secret as a `handleLeave` parameter only. Refusals go through
 * `recoverStepUp` AFTER the departure guard ends (a re-read of the method is no departure):
 * `VERIFICATION_FAILED` stays on the confirm step with the wrong-secret copy in `secretError`;
 * `VERIFICATION_REQUIRED` either asks again (PIN / pattern) or shows
 * `CURRENT_SECRET_UNAVAILABLE_MESSAGE` in `leaveError`, staying on the confirm step either way; a
 * 429 or any other refusal shows its copy and returns to idle. Mirrors useDeleteAccount.stepUp.
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

    expect(send).toHaveBeenCalledWith("fam-1", USER_ID, undefined);
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
    expect(hook.result.current.leaveError).toBe("嘗試次數過多，請稍後再試");
  });

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "離開家庭失敗，請稍後再試"],
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

const SECRET = "975310";

/** Client whose first method read answers `method`, every later one `reread` (default none). */
function setupStepUp(
  method: VerifyMethod | Error,
  leaveRes: LeaveRes | LeaveRes[],
  reread?: VerifyMethod,
) {
  const readsDuringDeparture: boolean[] = [];
  const answer = (m: VerifyMethod | Error) => {
    readsDuringDeparture.push(isSelfDepartureActive());
    return m instanceof Error
      ? Promise.reject(m)
      : Promise.resolve({ data: { method: m } });
  };
  const getVerifyMethod = vi
    .fn()
    .mockImplementationOnce(() => answer(method))
    .mockImplementation(() => answer(reread ?? "none"));
  const queue = Array.isArray(leaveRes) ? [...leaveRes] : null;
  const leaveFamily = vi.fn(async () =>
    queue ? queue.shift()! : (leaveRes as LeaveRes),
  );
  const onLogout = vi.fn();
  const apiClient = { getVerifyMethod, leaveFamily } as unknown as ApiClient;
  const hook = renderHook(() =>
    useLeaveFamily({ familyId: "fam-1", userId: USER_ID, apiClient, onLogout }),
  );
  return { hook, getVerifyMethod, leaveFamily, onLogout, readsDuringDeparture };
}

type StepUpHook = ReturnType<typeof setupStepUp>["hook"];

async function openConfirm(hook: StepUpHook) {
  await act(async () => {
    await hook.result.current.startConfirming();
  });
}

async function confirmLeave(hook: StepUpHook, secret?: string) {
  await act(async () => {
    await hook.result.current.handleLeave(secret);
  });
}

function refusal(code: string, extra: Record<string, unknown> = {}): LeaveRes {
  return { error: { code, message: "server text", ...extra } } as LeaveRes;
}

describe("useLeaveFamily current-secret step", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it.each<[string, VerifyMethod | Error, VerifyMethod | null]>([
    ["a PIN account", "pin", "pin"],
    ["a pattern account", "pattern", "pattern"],
    ["a none account", "none", "none"],
    ["a failed method read", new Error("network"), null],
  ])(
    "opens the confirm step with the method read for %s",
    async (_l, method, expected) => {
      const { hook, getVerifyMethod, leaveFamily } = setupStepUp(method, {
        data: { ok: true },
      });

      await openConfirm(hook);

      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(getVerifyMethod).toHaveBeenCalledWith(USER_ID);
      expect(hook.result.current.requiredMethod).toBe(expected);
      expect(hook.result.current.leaveState).toBe("confirming");
      expect(leaveFamily).not.toHaveBeenCalled();
    },
  );

  it("clears an earlier leave error when the confirm opens again", async () => {
    const { hook } = setupStepUp("none", refusal("SERVER_ERROR"));
    await openConfirm(hook);
    await confirmLeave(hook);
    // Positive companion for the cleared value below.
    expect(hook.result.current.leaveError).toBe("server text");

    await openConfirm(hook);

    expect(hook.result.current.leaveError).toBeNull();
    expect(hook.result.current.secretError).toBe("");
  });

  it("sends the entered secret with the leave and logs out, the departure mark up while sending", async () => {
    const { hook, leaveFamily, onLogout, readsDuringDeparture } = setupStepUp(
      "pin",
      { data: { ok: true } },
    );
    const marks: boolean[] = [];
    leaveFamily.mockImplementation(async () => {
      marks.push(isSelfDepartureActive());
      return { data: { ok: true } };
    });
    await openConfirm(hook);

    await confirmLeave(hook, SECRET);

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", USER_ID, SECRET);
    expect(marks).toEqual([true]);
    expect(readsDuringDeparture).toEqual([false]);
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(isSelfDepartureActive()).toBe(false);
    expectSecretNotStored(SECRET);
  });

  it("resends the same secret once after its own 401", async () => {
    const { hook, leaveFamily, onLogout } = setupStepUp("pin", [
      { error: { code: "UNAUTHORIZED", message: "revoked" } },
      { data: { ok: true } },
    ]);
    await openConfirm(hook);

    await confirmLeave(hook, SECRET);

    expect(leaveFamily).toHaveBeenCalledTimes(2);
    expect(leaveFamily.mock.calls).toEqual([
      ["fam-1", USER_ID, SECRET],
      ["fam-1", USER_ID, SECRET],
    ]);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it.each<[VerifyMethod, string]>([
    ["pin", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "keeps a %s account on the confirm step after a wrong secret",
    async (method, copy) => {
      const { hook, onLogout } = setupStepUp(
        method,
        refusal("VERIFICATION_FAILED"),
      );
      await openConfirm(hook);

      await confirmLeave(hook, SECRET);

      expect(hook.result.current.leaveState).toBe("confirming");
      expect(hook.result.current.requiredMethod).toBe(method);
      expect(hook.result.current.secretError).toBe(copy);
      expect(hook.result.current.leaveError).toBeNull();
      expect(onLogout).not.toHaveBeenCalled();
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  it("clears the wrong-secret copy when the secret is sent again", async () => {
    const { hook, onLogout } = setupStepUp("pin", [
      refusal("VERIFICATION_FAILED"),
      { data: { ok: true } },
    ]);
    await openConfirm(hook);
    await confirmLeave(hook, "000000");
    expect(hook.result.current.secretError).toBe(CURRENT_PIN_WRONG_MESSAGE);

    await confirmLeave(hook, SECRET);

    expect(hook.result.current.secretError).toBe("");
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("asks for the secret when VERIFICATION_REQUIRED re-reads a PIN, after the departure mark ends", async () => {
    const { hook, getVerifyMethod, readsDuringDeparture, onLogout } =
      setupStepUp("none", refusal("VERIFICATION_REQUIRED"), "pin");
    await openConfirm(hook);

    await confirmLeave(hook);

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(readsDuringDeparture).toEqual([false, false]);
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.leaveError).toBeNull();
    expect(hook.result.current.leaveState).toBe("confirming");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("asks again with the unavailable copy when a sent secret meets VERIFICATION_REQUIRED", async () => {
    const { hook } = setupStepUp(
      "pin",
      refusal("VERIFICATION_REQUIRED"),
      "pin",
    );
    await openConfirm(hook);

    await confirmLeave(hook, SECRET);

    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("confirming");
  });

  it("stays on the confirm step with the unavailable copy when the re-read is not PIN / pattern", async () => {
    const { hook, onLogout } = setupStepUp(
      "none",
      refusal("VERIFICATION_REQUIRED"),
      "code",
    );
    await openConfirm(hook);

    await confirmLeave(hook);

    expect(hook.result.current.leaveError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("confirming");
    expect(hook.result.current.requiredMethod).toBe("none");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it.each<[string, LeaveRes, string]>([
    [
      "VERIFICATION_LOCKED",
      refusal("VERIFICATION_LOCKED", { retryAfter: 90 }),
      buildRetryMessage("VERIFICATION_LOCKED", 90),
    ],
    [
      "RATE_LIMITED",
      refusal("RATE_LIMITED", { retryAfter: 30 }),
      buildRetryMessage("RATE_LIMITED", 30),
    ],
    [
      "OWNER_CANNOT_LEAVE after a correct secret",
      refusal("OWNER_CANNOT_LEAVE"),
      "管理者必須先轉移管理權才能離開家庭",
    ],
  ])("shows the copy for %s and returns to idle", async (_l, res, copy) => {
    const { hook, onLogout } = setupStepUp("pin", res);
    await openConfirm(hook);

    await confirmLeave(hook, SECRET);

    expect(hook.result.current.leaveError).toBe(copy);
    expect(hook.result.current.leaveState).toBe("idle");
    expect(hook.result.current.secretError).toBe("");
    expect(onLogout).not.toHaveBeenCalled();
    expect(isSelfDepartureActive()).toBe(false);
  });
});
