import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { ApiResponse } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY, USER_ID_KEY } from "@/constants";
import type { VerifyMethod } from "@/api/types";
import { useFamilySettingsDelete } from "@/dialog/useFamilySettingsDelete";
import { isSelfDepartureActive } from "@/storage/selfDeparture";
import { verificationLockedMessage } from "@/dialog/verificationMessages";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";

/**
 * useFamilySettingsDelete — the dialog's own "delete account" flow, sent
 * through `runGuardedDeparture` (#263) so a 401 raised while the deletion is in
 * flight cannot trigger a silent recovery join that re-adds the user. On
 * success it still wipes `browser.storage.local` (which takes the departure
 * mark with it) before `onLeave`; outcomes and copy are unchanged. Twin:
 * `pwa/tests/unit/hooks/useDeleteAccount.test.ts`.
 *
 * Step-up (#396): `startConfirming` reads the verify method once; a PIN / pattern account then sends
 * its current secret as `deleteAccount`'s second argument. A wrong secret keeps the confirm step open
 * with the method's wrong-secret copy on the entry; `VERIFICATION_REQUIRED` re-reads the method and
 * stays in the confirm step; a failed method read leaves `requiredMethod` null and the delete goes out
 * without a secret. The secret is a call argument only — never written to `browser.storage.local`.
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

    expect(send).toHaveBeenCalledWith("user-1", undefined);
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
    ["a non-Error value", "boom", "移除帳戶失敗，請稍後再試"],
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

/** Each `getVerifyMethod` call takes the next of `methods` (null: an error envelope; "throw": a
 *  rejection); each `deleteAccount` call the next of `responses`. See the header, "Step-up". */
function setupStepUp(
  methods: (VerifyMethod | null | "throw")[],
  responses: DeleteRes[],
) {
  const getVerifyMethod = vi.fn(async () => {
    const method = methods.shift();
    if (method === "throw") throw new Error("offline");
    if (method === null || method === undefined) {
      return { error: { code: "SERVER_ERROR", message: "boom" } };
    }
    return { data: { method } };
  });
  const deleteAccount = vi.fn<
    (userId: string, secret?: string) => Promise<DeleteRes>
  >(async () => responses.shift()!);
  const onLeave = vi.fn();
  const apiClient = { getVerifyMethod, deleteAccount } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsDelete({ userId: "user-1", apiClient, onLeave }),
  );
  const start = () =>
    act(async () => {
      await hook.result.current.startConfirming();
    });
  const confirm = (secret?: string) =>
    act(async () => {
      await hook.result.current.handleDeleteConfirm(secret);
    });
  return { hook, getVerifyMethod, deleteAccount, onLeave, start, confirm };
}

/** True when any `browser.storage.local.set` call so far carried `secret`. */
function storageSawSecret(secret: string): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some((call) => JSON.stringify(call[0]).includes(secret));
}

describe("useFamilySettingsDelete step-up (#396)", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [USER_ID_KEY]: "user-1" });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("reads the method once, then opens the confirm step", async () => {
    const { hook, getVerifyMethod, deleteAccount, start } = setupStepUp(
      ["pin"],
      [],
    );

    await start();

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(getVerifyMethod).toHaveBeenCalledWith("user-1");
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.deleteState).toBe("confirming");
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("sends the current secret with the delete and never stores it", async () => {
    const { deleteAccount, onLeave, start, confirm } = setupStepUp(
      ["pin"],
      [{ data: { ok: true } }],
    );

    await start();
    await confirm("482913");

    expect(deleteAccount).toHaveBeenCalledWith("user-1", "482913");
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
      const refused: DeleteRes = {
        error: { code: "VERIFICATION_FAILED", message: "server text" },
      };
      const { hook, getVerifyMethod, onLeave, start, confirm } = setupStepUp(
        [method],
        [refused],
      );

      await start();
      await confirm(secret);

      expect(hook.result.current.deleteState).toBe("confirming");
      expect(hook.result.current.secretError).toBe(message);
      expect(hook.result.current.deleteError).toBe("");
      expect(hook.result.current.requiredMethod).toBe(method);
      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(onLeave).not.toHaveBeenCalled();
      expect(await isSelfDepartureActive()).toBe(false);
      expect((await chrome.storage.local.get(USER_ID_KEY))[USER_ID_KEY]).toBe(
        "user-1",
      );
      expect(storageSawSecret(secret)).toBe(false);
    },
  );

  it("asks for the secret when the server requires one the first read missed", async () => {
    const { hook, getVerifyMethod, deleteAccount, start, confirm } =
      setupStepUp(
        ["throw", "pin"],
        [{ error: { code: "VERIFICATION_REQUIRED", message: "server text" } }],
      );

    await start();
    expect(hook.result.current.requiredMethod).toBeNull();
    await confirm();

    expect(deleteAccount).toHaveBeenCalledWith("user-1", undefined);
    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.deleteState).toBe("confirming");
    expect(hook.result.current.requiredMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.deleteError).toBe("");
  });

  it("stays in the confirm step with the unavailable copy when the re-read is not PIN / pattern", async () => {
    const { hook, getVerifyMethod, start, confirm } = setupStepUp(
      ["none", "none"],
      [{ error: { code: "VERIFICATION_REQUIRED", message: "server text" } }],
    );

    await start();
    await confirm();

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.deleteState).toBe("confirming");
    expect(hook.result.current.deleteError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(hook.result.current.requiredMethod).toBe("none");
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

    expect(hook.result.current.deleteError).toBe(
      verificationLockedMessage(900),
    );
    expect(hook.result.current.deleteState).toBe("idle");
    expect(onLeave).not.toHaveBeenCalled();
  });

  it.each<[string, (VerifyMethod | null | "throw")[]]>([
    ["a none account", ["none"]],
    ["a code account", ["code"]],
    ["a failed method read", [null]],
    ["a rejected method read", ["throw"]],
  ])("deletes without a secret for %s", async (_label, methods) => {
    const { hook, deleteAccount, onLeave, start, confirm } = setupStepUp(
      methods,
      [{ data: { ok: true } }],
    );

    await start();
    expect(hook.result.current.deleteState).toBe("confirming");
    await confirm();

    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith("user-1", undefined);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("clears the previous secret error when the confirm step is opened again", async () => {
    const { hook, start, confirm } = setupStepUp(
      ["pin", "pin"],
      [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }],
    );

    await start();
    await confirm("482913");
    expect(hook.result.current.secretError).toBe(CURRENT_PIN_WRONG_MESSAGE);
    act(() => hook.result.current.setDeleteState("idle"));
    await start();

    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.deleteState).toBe("confirming");
  });
});
