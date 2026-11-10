import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { ApiResponse, VerifyMethod } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/constants";
import { DEPARTURE_SERVER_CHANGED_MESSAGE } from "@/dialog/departureServerPin";
import { useFamilySettingsLeave } from "@/dialog/useFamilySettingsLeave";
import {
  rateLimitedEnvelopeMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";
import { isSelfDepartureActive } from "@/storage/selfDeparture";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";

/**
 * useFamilySettingsLeave — the dialog's own "leave family" flow, sent through
 * `runGuardedDeparture` (#263) so a 401 raised while the leave is in flight
 * cannot trigger `doRefreshToken`'s silent recovery join and re-add the user.
 * The outcomes and copy are the pre-#263 ones; what this file adds is that the
 * departure mark is up while the request and its settling run, and gone
 * afterwards in every branch. Twin: `pwa/tests/unit/hooks/useLeaveFamily.test.ts`.
 *
 * Step-up: `startConfirming` reads the verify method once; a PIN / pattern account then sends its
 * current secret as `leaveFamily`'s third argument. A wrong secret keeps the confirm step open with the
 * method's wrong-secret copy on the entry; `VERIFICATION_REQUIRED` re-reads the method and stays in the
 * confirm step; a failed method read leaves `requiredMethod` null and the leave goes out without a
 * secret. A refusal is handled only after the departure guard has ended, so the re-read runs with no
 * departure mark up, and only on the server the leave was confirmed on (`pinDepartureServer`). The
 * secret is a call argument only — never written to `browser.storage.local`.
 *
 * Server pin: `startConfirming` pins the server BEFORE its method read and the whole confirm session
 * reuses that pin, so a secret typed for server A is never sent to server B. A switch during the read
 * ends the session at idle with `DEPARTURE_SERVER_CHANGED_MESSAGE`; a switch while the confirm step is
 * open (also after a wrong-secret refusal) stops the press before any request. Back at idle the pin is
 * dropped, so a later session or press pins afresh; a superseded `startConfirming` (a second click)
 * changes nothing when its read resolves. Reads in that suite stay pending until the case answers them.
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
  const apiClient = {
    leaveFamily: send,
    getEndpoint: () => "https://api.example",
  } as unknown as ApiClient;
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

    expect(send).toHaveBeenCalledWith("fam-1", "user-1", undefined);
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
    ["a non-Error value", "boom", "離開家庭失敗，請稍後再試"],
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

/** Each `getVerifyMethod` call takes the next of `methods` (null: an error envelope; "throw": a
 *  rejection) and records whether the departure mark was up; each `leaveFamily` the next response. */
function setupStepUp(
  methods: (VerifyMethod | null | "throw")[],
  responses: LeaveRes[],
) {
  const markDuringRead: boolean[] = [];
  const getVerifyMethod = vi.fn(async () => {
    markDuringRead.push(await isSelfDepartureActive());
    const method = methods.shift();
    if (method === "throw") throw new Error("offline");
    if (method === null || method === undefined) {
      return { error: { code: "SERVER_ERROR", message: "boom" } };
    }
    return { data: { method } };
  });
  const leaveFamily = vi.fn<
    (familyId: string, userId: string, secret?: string) => Promise<LeaveRes>
  >(async () => responses.shift()!);
  const onLeave = vi.fn();
  const endpoint = { current: "https://api.example" };
  const apiClient = {
    getVerifyMethod,
    leaveFamily,
    getEndpoint: () => endpoint.current,
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsLeave({
      familyId: "fam-1",
      userId: "user-1",
      apiClient,
      onLeave,
    }),
  );
  const start = () =>
    act(async () => {
      await hook.result.current.startConfirming();
    });
  const confirm = (secret?: string) =>
    act(async () => {
      await hook.result.current.handleLeaveConfirm(secret);
    });
  return {
    hook,
    getVerifyMethod,
    leaveFamily,
    onLeave,
    endpoint,
    markDuringRead,
    start,
    confirm,
  };
}

/** True when any `browser.storage.local.set` call so far carried `secret`. */
function storageSawSecret(secret: string): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some((call) => JSON.stringify(call[0]).includes(secret));
}

const SECRET_REQUIRED: LeaveRes = {
  error: { code: "VERIFICATION_REQUIRED", message: "server text" },
};

describe("useFamilySettingsLeave step-up", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("reads the method once, then opens the confirm step", async () => {
    const { hook, getVerifyMethod, leaveFamily, start } = setupStepUp(
      ["pin"],
      [],
    );

    await start();

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(getVerifyMethod).toHaveBeenCalledWith("user-1");
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.leaveState).toBe("confirming");
    expect(leaveFamily).not.toHaveBeenCalled();
  });

  it("sends the current secret with the leave and never stores it", async () => {
    const { leaveFamily, onLeave, start, confirm } = setupStepUp(
      ["pin"],
      [{ data: { ok: true } }],
    );

    await start();
    await confirm("482913");

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "482913");
    expect(onLeave).toHaveBeenCalledTimes(1);
    // Positive companion: the departure mark write proves the spy sees this flow's writes.
    const keys = vi
      .mocked(chrome.storage.local.set)
      .mock.calls.flatMap((call) => Object.keys(call[0] as object));
    expect(keys).toContain(SELF_DEPARTURE_UNTIL_KEY);
    expect(storageSawSecret("482913")).toBe(false);
  });

  it.each<[VerifyMethod, string, string]>([
    ["pin", "482913", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", "0,3,6,7", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "keeps the %s confirm step open with the wrong-secret copy",
    async (method, secret, message) => {
      const { hook, getVerifyMethod, onLeave, start, confirm } = setupStepUp(
        [method],
        [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }],
      );

      await start();
      await confirm(secret);

      expect(hook.result.current.leaveState).toBe("confirming");
      expect(hook.result.current.secretError).toBe(message);
      expect(hook.result.current.leaveError).toBe("");
      expect(hook.result.current.requiredMethod).toBe(method);
      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(onLeave).not.toHaveBeenCalled();
      expect(await isSelfDepartureActive()).toBe(false);
      expect(storageSawSecret(secret)).toBe(false);
    },
  );

  it("asks for the secret when the server requires one the first read missed, re-reading with no mark up", async () => {
    const {
      hook,
      getVerifyMethod,
      leaveFamily,
      markDuringRead,
      start,
      confirm,
    } = setupStepUp(["throw", "pin"], [SECRET_REQUIRED]);

    await start();
    expect(hook.result.current.requiredMethod).toBeNull();
    await confirm();

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", undefined);
    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    // See the header → "Step-up": the re-read runs after the departure guard ended.
    expect(markDuringRead).toEqual([false, false]);
    expect(hook.result.current.leaveState).toBe("confirming");
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.leaveError).toBe("");
  });

  it("says the sent secret could not be checked when the server still requires one", async () => {
    const { hook, start, confirm } = setupStepUp(
      ["pin", "pin"],
      [SECRET_REQUIRED],
    );

    await start();
    await confirm("482913");

    expect(hook.result.current.leaveState).toBe("confirming");
    expect(hook.result.current.secretError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
  });

  it("stays in the confirm step with the unavailable copy when the re-read is not PIN / pattern", async () => {
    const { hook, getVerifyMethod, onLeave, start, confirm } = setupStepUp(
      ["none", "none"],
      [SECRET_REQUIRED],
    );

    await start();
    await confirm();

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.leaveState).toBe("confirming");
    expect(hook.result.current.leaveError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(hook.result.current.requiredMethod).toBe("none");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("shows the lock copy, not the server's text, when the secret is locked out", async () => {
    const { hook, onLeave, start, confirm } = setupStepUp(
      ["pin"],
      [
        {
          error: {
            code: "VERIFICATION_LOCKED",
            message: "server text",
            retryAfter: 900,
          },
        },
      ],
    );

    await start();
    await confirm("482913");

    expect(hook.result.current.leaveError).toBe(verificationLockedMessage(900));
    expect(hook.result.current.leaveState).toBe("idle");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("re-reads nothing on another server when the endpoint changed during the refused leave", async () => {
    const { hook, getVerifyMethod, leaveFamily, endpoint, start, confirm } =
      setupStepUp(["none", "pin"], []);
    leaveFamily.mockImplementationOnce(async () => {
      endpoint.current = "https://other.example";
      return SECRET_REQUIRED;
    });

    await start();
    await confirm();

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(hook.result.current.leaveError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("idle");
  });

  it.each<[string, (VerifyMethod | null | "throw")[]]>([
    ["a none account", ["none"]],
    ["a code account", ["code"]],
    ["a failed method read", [null]],
    ["a rejected method read", ["throw"]],
  ])("leaves without a secret for %s", async (_label, methods) => {
    const { hook, leaveFamily, onLeave, start, confirm } = setupStepUp(
      methods,
      [{ data: { ok: true } }],
    );

    await start();
    expect(hook.result.current.leaveState).toBe("confirming");
    await confirm();

    expect(leaveFamily).toHaveBeenCalledTimes(1);
    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", undefined);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("clears the previous secret error when the confirm step is opened again", async () => {
    const { hook, start, confirm } = setupStepUp(
      ["pin", "pin"],
      [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }],
    );

    await start();
    await confirm("000000");
    expect(hook.result.current.secretError).toBe(CURRENT_PIN_WRONG_MESSAGE);
    act(() => hook.result.current.setLeaveState("idle"));
    await start();

    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.leaveState).toBe("confirming");
  });

  it("clears the previous leave error when the confirm step is opened again", async () => {
    const { hook, start, confirm } = setupStepUp(
      ["pin", "pin"],
      [{ error: { code: "OWNER_CANNOT_LEAVE", message: "owner" } }],
    );

    await start();
    await confirm("482913");
    expect(hook.result.current.leaveError).toBe(
      "管理者必須先轉移管理權才能離開家庭",
    );
    await start();

    expect(hook.result.current.leaveError).toBe("");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.leaveState).toBe("confirming");
  });
});

const SERVER_A = "https://a.example";
const SERVER_B = "https://b.example";

/** Each `getVerifyMethod` call stays pending until `answer` resolves it; `endpoint.current` is the
 *  client's server. See the header → "Server pin". */
function setupServerPin(responses: LeaveRes[]) {
  const answers: Array<(method: VerifyMethod) => void> = [];
  const getVerifyMethod = vi.fn(
    () =>
      new Promise((resolve) => {
        answers.push((method) => resolve({ data: { method } }));
      }),
  );
  const leaveFamily = vi.fn<
    (familyId: string, userId: string, secret?: string) => Promise<LeaveRes>
  >(async () => responses.shift()!);
  const endpoint = { current: SERVER_A };
  const apiClient = {
    getVerifyMethod,
    leaveFamily,
    getEndpoint: () => endpoint.current,
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsLeave({
      familyId: "fam-1",
      userId: "user-1",
      apiClient,
      onLeave: vi.fn(),
    }),
  );
  /** Starts `startConfirming` and returns it still waiting on its method read. */
  const begin = () => {
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.startConfirming();
    });
    return pending;
  };
  const answer = (pending: Promise<void>, read: number, method: VerifyMethod) =>
    act(async () => {
      answers[read](method);
      await pending;
    });
  const open = (method: VerifyMethod) => {
    const pending = begin();
    return answer(pending, answers.length - 1, method);
  };
  const confirm = (secret?: string) =>
    act(async () => {
      await hook.result.current.handleLeaveConfirm(secret);
    });
  const cancel = () => act(() => hook.result.current.setLeaveState("idle"));
  return { hook, leaveFamily, endpoint, begin, answer, open, confirm, cancel };
}

describe("useFamilySettingsLeave server pin", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("never sends the secret when the server changed while the confirm step was open", async () => {
    const { hook, leaveFamily, endpoint, open, confirm } = setupServerPin([
      { data: { ok: true } },
    ]);

    await open("pin");
    expect(hook.result.current.leaveState).toBe("confirming");
    endpoint.current = SERVER_B;
    await confirm("1234");

    expect(leaveFamily).not.toHaveBeenCalled();
    expect(hook.result.current.leaveError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("idle");
  });

  it("never opens the confirm step when the server changed during the method read", async () => {
    const { hook, leaveFamily, endpoint, begin, answer } = setupServerPin([]);

    const pending = begin();
    endpoint.current = SERVER_B;
    await answer(pending, 0, "pin");

    expect(hook.result.current.leaveState).toBe("idle");
    expect(hook.result.current.requiredMethod).toBeNull();
    expect(hook.result.current.leaveError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(leaveFamily).not.toHaveBeenCalled();
  });

  it("keeps the first pin after a wrong-secret refusal and stops the second press", async () => {
    const { hook, leaveFamily, endpoint, open, confirm } = setupServerPin([
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
      { data: { ok: true } },
    ]);

    await open("pin");
    await confirm("1234");
    expect(hook.result.current.leaveState).toBe("confirming");
    endpoint.current = SERVER_B;
    await confirm("5678");

    expect(leaveFamily).toHaveBeenCalledTimes(1);
    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "1234");
    expect(hook.result.current.leaveError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.leaveState).toBe("idle");
  });

  it("pins the new server for a session opened after a cancel", async () => {
    const { hook, leaveFamily, endpoint, open, confirm, cancel } =
      setupServerPin([{ data: { ok: true } }]);

    await open("pin");
    cancel();
    endpoint.current = SERVER_B;
    await open("pin");
    await confirm("1234");

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "1234");
    expect(hook.result.current.leaveError).toBe("");
  });

  it("re-pins at the press when the cancelled session's pin was dropped", async () => {
    const { hook, leaveFamily, endpoint, open, confirm, cancel } =
      setupServerPin([{ data: { ok: true } }]);

    await open("none");
    cancel();
    endpoint.current = SERVER_B;
    await confirm();

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", undefined);
    expect(hook.result.current.leaveError).toBe("");
  });

  it.each([
    ["first", [0, 1]],
    ["second", [1, 0]],
  ])(
    "ignores a superseded start when the %s read resolves first",
    async (_label, order) => {
      const { hook, leaveFamily, endpoint, begin, answer, confirm } =
        setupServerPin([{ data: { ok: true } }]);
      const methods: VerifyMethod[] = ["pattern", "pin"];

      const pendings = [begin()];
      endpoint.current = SERVER_B;
      pendings.push(begin());
      for (const read of order) {
        await answer(pendings[read], read, methods[read]);
        // Only the second (current) start may open the confirm step.
        const opened = order.indexOf(1) <= order.indexOf(read);
        expect(hook.result.current.leaveState).toBe(
          opened ? "confirming" : "idle",
        );
        expect(hook.result.current.requiredMethod).toBe(opened ? "pin" : null);
        expect(hook.result.current.leaveError).toBe("");
      }
      await confirm("1234");

      expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "1234");
      expect(hook.result.current.leaveError).toBe("");
    },
  );
});
