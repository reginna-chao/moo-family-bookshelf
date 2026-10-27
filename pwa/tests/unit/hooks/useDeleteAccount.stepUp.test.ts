import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { useDeleteAccount } from "@/hooks/useDeleteAccount";
import { buildRetryMessage } from "@/utils/retryMessage";
import {
  isSelfDepartureActive,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";
import { expectSecretNotStored } from "../../helpers/secretStorage";

/**
 * useDeleteAccount — the current-secret step-up before deleting the account (#396). Twin:
 * `extension/tests/unit/dialog/useFamilySettingsDelete.test.ts`.
 *
 * `startConfirming` reads the method once and opens the confirm step with `requiredMethod` set (null
 * when the read failed: no secret is asked and the server decides). The delete sends the entered
 * secret as a parameter only. Refusals: `VERIFICATION_FAILED` stays on the confirm step with the
 * wrong-secret copy in `secretError`; `VERIFICATION_REQUIRED` re-reads the method — after the
 * departure mark is gone, since a re-read is no departure — and either asks for the secret (PIN /
 * pattern) or shows `CURRENT_SECRET_UNAVAILABLE_MESSAGE` in `deleteError`, staying on the confirm
 * step either way; a 429 shows the back-off copy and returns to idle like any other refusal.
 */

type DeleteRes = ApiResponse<{ ok: boolean }>;

const USER_ID = "a".repeat(64);
const SECRET = "975310";

function setup(
  method: VerifyMethod | Error,
  deleteRes: DeleteRes,
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
  const deleteAccount = vi.fn().mockResolvedValue(deleteRes);
  const onForceLogout = vi.fn();
  const apiClient = { getVerifyMethod, deleteAccount } as unknown as ApiClient;
  const hook = renderHook(() =>
    useDeleteAccount({ userId: USER_ID, apiClient, onForceLogout }),
  );
  return {
    hook,
    getVerifyMethod,
    deleteAccount,
    onForceLogout,
    readsDuringDeparture,
  };
}

type Hook = ReturnType<typeof setup>["hook"];

async function openConfirm(hook: Hook) {
  await act(async () => {
    await hook.result.current.startConfirming();
  });
}

async function confirmDelete(hook: Hook, secret?: string) {
  await act(async () => {
    await hook.result.current.handleDeleteAccount(secret);
  });
}

function refusal(code: string, extra: Record<string, unknown> = {}): DeleteRes {
  return { error: { code, message: "server text", ...extra } } as DeleteRes;
}

describe("useDeleteAccount step-up", () => {
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
      const { hook, getVerifyMethod } = setup(method, { data: { ok: true } });

      await openConfirm(hook);

      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(getVerifyMethod).toHaveBeenCalledWith(USER_ID);
      expect(hook.result.current.requiredMethod).toBe(expected);
      expect(hook.result.current.deleteState).toBe("confirming");
    },
  );

  it("sends the entered secret with the delete and logs out on success", async () => {
    const { hook, deleteAccount, onForceLogout } = setup("pin", {
      data: { ok: true },
    });
    await openConfirm(hook);

    await confirmDelete(hook, SECRET);

    expect(deleteAccount).toHaveBeenCalledWith(USER_ID, SECRET);
    expect(onForceLogout).toHaveBeenCalledTimes(1);
    expectSecretNotStored(SECRET);
  });

  it.each<[VerifyMethod, string]>([
    ["pin", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "keeps a %s account on the confirm step after a wrong secret",
    async (method, copy) => {
      const { hook, onForceLogout } = setup(
        method,
        refusal("VERIFICATION_FAILED"),
      );
      await openConfirm(hook);

      await confirmDelete(hook, SECRET);

      expect(hook.result.current.deleteState).toBe("confirming");
      expect(hook.result.current.secretError).toBe(copy);
      expect(hook.result.current.deleteError).toBeNull();
      expect(onForceLogout).not.toHaveBeenCalled();
      expect(isSelfDepartureActive()).toBe(false);
    },
  );

  it("asks for the secret when VERIFICATION_REQUIRED re-reads a PIN, after the departure mark ends", async () => {
    const { hook, getVerifyMethod, readsDuringDeparture } = setup(
      "none",
      refusal("VERIFICATION_REQUIRED"),
      "pin",
    );
    await openConfirm(hook);

    await confirmDelete(hook);

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(readsDuringDeparture).toEqual([false, false]);
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.deleteError).toBeNull();
    expect(hook.result.current.deleteState).toBe("confirming");
  });

  it("stays on the confirm step with the unavailable copy when the re-read is not PIN / pattern", async () => {
    const { hook } = setup("none", refusal("VERIFICATION_REQUIRED"), "code");
    await openConfirm(hook);

    await confirmDelete(hook);

    expect(hook.result.current.deleteError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(hook.result.current.deleteState).toBe("confirming");
    expect(hook.result.current.requiredMethod).toBe("none");
  });

  it.each<[string, DeleteRes, string]>([
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
  ])(
    "shows the back-off copy for %s and returns to idle",
    async (_l, res, copy) => {
      const { hook, onForceLogout } = setup("pin", res);
      await openConfirm(hook);

      await confirmDelete(hook, SECRET);

      expect(hook.result.current.deleteError).toBe(copy);
      expect(hook.result.current.deleteState).toBe("idle");
      expect(onForceLogout).not.toHaveBeenCalled();
    },
  );
});
