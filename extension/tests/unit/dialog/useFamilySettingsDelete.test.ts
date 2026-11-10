import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { ApiResponse } from "@/api/types";
import {
  API_ENDPOINT_KEY,
  FAMILY_ID_KEY,
  SELF_DEPARTURE_UNTIL_KEY,
  USER_ID_KEY,
} from "@/constants";
import type { VerifyMethod } from "@/api/types";
import { DEPARTURE_SERVER_CHANGED_MESSAGE } from "@/dialog/departureServerPin";
import {
  DELETED_ELSEWHERE_MESSAGE,
  useFamilySettingsDelete,
} from "@/dialog/useFamilySettingsDelete";
import { isSelfDepartureActive } from "@/storage/selfDeparture";
import { verificationLockedMessage } from "@/dialog/verificationMessages";
import { ACCOUNT_DELETED_ERROR_CODE } from "moo-family-bookshelf-shared/api/accountDeleted";
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
 *
 * Already deleted (#462): the Worker answers `401 ACCOUNT_DELETED` when an earlier delete finished but
 * its response was lost, and the hook counts that as success. "Called once" below counts `deleteAccount`
 * calls, not network requests: the real 401 path inside the client also posts a refresh. A plain
 * `UNAUTHORIZED` on both sends must keep today's failure, so the rewrite cannot swallow it.
 *
 * Stored binding: a success clears storage only while it still holds the userId + familyId the delete
 * was sent for, so every suite seeds `BOUND`. When another tab bound storage to another family or
 * account while the delete was in flight, the success leaves storage alone, skips `onLeave`, returns
 * to idle and shows `DELETED_ELSEWHERE_MESSAGE`. When another tab only LEFT mid-delete (familyId
 * removed, the same userId kept) there is no other session to keep: the success still clears storage
 * and calls `onLeave`, so a deleted account's cache never stays behind. A binding read that rejects
 * still clears and leaves: the server account is gone, so the Dialog must not get stuck on a failed read.
 *
 * Server pin: `startConfirming` pins the server BEFORE its method read and the whole confirm session
 * reuses that pin, so a secret typed for server A is never sent to server B. A switch during the read
 * ends the session at idle with `DEPARTURE_SERVER_CHANGED_MESSAGE`; a switch while the confirm step is
 * open (also after a wrong-secret refusal) stops the press before any request. Back at idle the pin is
 * dropped, so a later session or press pins afresh; a superseded `startConfirming` (a second click)
 * changes nothing when its read resolves. Reads in that suite stay pending until the case answers them.
 */

type DeleteRes = ApiResponse<{ ok: boolean }>;

const BOUND = { [USER_ID_KEY]: "user-1", [FAMILY_ID_KEY]: "fam-1" };

const ALREADY_DELETED: DeleteRes = {
  error: { code: "ACCOUNT_DELETED", message: "這個帳戶已經移除" },
};
const TOKEN_REFUSED: DeleteRes = {
  error: { code: "UNAUTHORIZED", message: "revoked" },
};

function setup(deleteAccount: () => Promise<DeleteRes>) {
  const seen = { send: [] as boolean[] };
  // vi.fn records the call's arguments even though this body ignores them.
  const send = vi.fn(async () => {
    seen.send.push(await isSelfDepartureActive());
    return deleteAccount();
  });
  const onLeave = vi.fn();
  const apiClient = {
    deleteAccount: send,
    getEndpoint: () => "https://api.example",
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsDelete({
      userId: "user-1",
      familyId: "fam-1",
      apiClient,
      onLeave,
    }),
  );
  const confirmDelete = async (currentSecret?: string) => {
    await act(async () => {
      await hook.result.current.handleDeleteConfirm(currentSecret);
    });
  };
  return { hook, send, onLeave, seen, confirmDelete };
}

describe("useFamilySettingsDelete", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(BOUND);
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

  it("uses the code the production constant names", () => {
    expect(ALREADY_DELETED.error?.code).toBe(ACCOUNT_DELETED_ERROR_CODE);
  });

  it.each<[string, string | undefined]>([
    ["without a secret", undefined],
    ["with the current secret", "482913"],
  ])(
    "counts ACCOUNT_DELETED as success %s, with deleteAccount called once",
    async (_label, secret) => {
      const { hook, send, onLeave, seen, confirmDelete } = setup(
        async () => ALREADY_DELETED,
      );

      await confirmDelete(secret);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("user-1", secret);
      expect(seen.send).toEqual([true]);
      expect(chrome.storage.local.clear).toHaveBeenCalledTimes(1);
      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(hook.result.current.deleteError).toBe("");
      expect(hook.result.current.secretError).toBe("");
      expect(await chrome.storage.local.get(null)).toEqual({});
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it("counts ACCOUNT_DELETED on the resend as success, with deleteAccount called twice", async () => {
    const responses: DeleteRes[] = [TOKEN_REFUSED, ALREADY_DELETED];
    const { hook, send, onLeave, seen, confirmDelete } = setup(async () =>
      responses.shift()!,
    );

    await confirmDelete();

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(chrome.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
    expect(await chrome.storage.local.get(null)).toEqual({});
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it("resends once and shows the failure when both sends come back UNAUTHORIZED", async () => {
    const { hook, send, onLeave, seen, confirmDelete } = setup(
      async () => TOKEN_REFUSED,
    );

    await confirmDelete();

    expect(send).toHaveBeenCalledTimes(2);
    expect(seen.send).toEqual([true, false]);
    expect(onLeave).not.toHaveBeenCalled();
    expect(chrome.storage.local.clear).not.toHaveBeenCalled();
    expect(hook.result.current.deleteError).toBe("revoked");
    expect(hook.result.current.deleteState).toBe("idle");
    expect(await isSelfDepartureActive()).toBe(false);
    // Local data survives a refused deletion.
    expect((await chrome.storage.local.get(USER_ID_KEY))[USER_ID_KEY]).toBe(
      "user-1",
    );
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
  const apiClient = {
    getVerifyMethod,
    deleteAccount,
    getEndpoint: () => "https://api.example",
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsDelete({
      userId: "user-1",
      familyId: "fam-1",
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
    await chrome.storage.local.set(BOUND);
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

const SERVER_A = "https://a.example";
const SERVER_B = "https://b.example";

/** Each `getVerifyMethod` call stays pending until `answer` resolves it; `endpoint.current` is the
 *  client's server. See the header → "Server pin". */
function setupServerPin(responses: DeleteRes[]) {
  const answers: Array<(method: VerifyMethod) => void> = [];
  const getVerifyMethod = vi.fn(
    () =>
      new Promise((resolve) => {
        answers.push((method) => resolve({ data: { method } }));
      }),
  );
  const deleteAccount = vi.fn<
    (userId: string, secret?: string) => Promise<DeleteRes>
  >(async () => responses.shift()!);
  const onLeave = vi.fn();
  const endpoint = { current: SERVER_A };
  const apiClient = {
    getVerifyMethod,
    deleteAccount,
    getEndpoint: () => endpoint.current,
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useFamilySettingsDelete({
      userId: "user-1",
      familyId: "fam-1",
      apiClient,
      onLeave,
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
      await hook.result.current.handleDeleteConfirm(secret);
    });
  const cancel = () => act(() => hook.result.current.setDeleteState("idle"));
  return {
    hook,
    deleteAccount,
    onLeave,
    endpoint,
    begin,
    answer,
    open,
    confirm,
    cancel,
  };
}

describe("useFamilySettingsDelete server pin", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(BOUND);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("never sends the secret when the server changed while the confirm step was open", async () => {
    const { hook, deleteAccount, onLeave, endpoint, open, confirm } =
      setupServerPin([{ data: { ok: true } }]);

    await open("pin");
    expect(hook.result.current.deleteState).toBe("confirming");
    endpoint.current = SERVER_B;
    await confirm("1234");

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
    expect(hook.result.current.deleteError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.deleteState).toBe("idle");
  });

  it("never opens the confirm step when the server changed during the method read", async () => {
    const { hook, deleteAccount, endpoint, begin, answer } = setupServerPin([]);

    const pending = begin();
    endpoint.current = SERVER_B;
    await answer(pending, 0, "pin");

    expect(hook.result.current.deleteState).toBe("idle");
    expect(hook.result.current.requiredMethod).toBeNull();
    expect(hook.result.current.deleteError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("keeps the first pin after a wrong-secret refusal and stops the second press", async () => {
    const { hook, deleteAccount, endpoint, open, confirm } = setupServerPin([
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
      { data: { ok: true } },
    ]);

    await open("pin");
    await confirm("1234");
    expect(hook.result.current.deleteState).toBe("confirming");
    endpoint.current = SERVER_B;
    await confirm("5678");

    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteAccount).toHaveBeenCalledWith("user-1", "1234");
    expect(hook.result.current.deleteError).toBe(
      DEPARTURE_SERVER_CHANGED_MESSAGE,
    );
    expect(hook.result.current.deleteState).toBe("idle");
  });

  it("pins the new server for a session opened after a cancel", async () => {
    const { hook, deleteAccount, onLeave, endpoint, open, confirm, cancel } =
      setupServerPin([{ data: { ok: true } }]);

    await open("pin");
    cancel();
    endpoint.current = SERVER_B;
    await open("pin");
    await confirm("1234");

    expect(deleteAccount).toHaveBeenCalledWith("user-1", "1234");
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
  });

  it("re-pins at the press when the cancelled session's pin was dropped", async () => {
    const { hook, deleteAccount, endpoint, open, confirm, cancel } =
      setupServerPin([{ data: { ok: true } }]);

    await open("none");
    cancel();
    endpoint.current = SERVER_B;
    await confirm();

    expect(deleteAccount).toHaveBeenCalledWith("user-1", undefined);
    expect(hook.result.current.deleteError).toBe("");
  });

  it.each([
    ["first", [0, 1]],
    ["second", [1, 0]],
  ])(
    "ignores a superseded start when the %s read resolves first",
    async (_label, order) => {
      const { hook, deleteAccount, endpoint, begin, answer, confirm } =
        setupServerPin([{ data: { ok: true } }]);
      const methods: VerifyMethod[] = ["pattern", "pin"];

      const pendings = [begin()];
      endpoint.current = SERVER_B;
      pendings.push(begin());
      for (const read of order) {
        await answer(pendings[read], read, methods[read]);
        // Only the second (current) start may open the confirm step.
        const opened = order.indexOf(1) <= order.indexOf(read);
        expect(hook.result.current.deleteState).toBe(
          opened ? "confirming" : "idle",
        );
        expect(hook.result.current.requiredMethod).toBe(opened ? "pin" : null);
        expect(hook.result.current.deleteError).toBe("");
      }
      await confirm("1234");

      expect(deleteAccount).toHaveBeenCalledWith("user-1", "1234");
      expect(hook.result.current.deleteError).toBe("");
    },
  );
});

describe("useFamilySettingsDelete stored binding", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(BOUND);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  /** The stored userId + familyId right now. */
  async function storedBinding() {
    return chrome.storage.local.get([USER_ID_KEY, FAMILY_ID_KEY]);
  }

  it.each<[string, Record<string, string>, DeleteRes]>([
    ["another family", { [FAMILY_ID_KEY]: "fam-2" }, { data: { ok: true } }],
    ["another account", { [USER_ID_KEY]: "user-2" }, { data: { ok: true } }],
    [
      "another family (ACCOUNT_DELETED)",
      { [FAMILY_ID_KEY]: "fam-2" },
      ALREADY_DELETED,
    ],
  ])(
    "leaves storage alone and shows the stale-window copy when storage switched to %s mid-delete",
    async (_label, switched, response) => {
      const { hook, send, onLeave, confirmDelete } = setup(async () => {
        await chrome.storage.local.set(switched);
        return response;
      });

      await confirmDelete();

      expect(send).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.clear).not.toHaveBeenCalled();
      expect(onLeave).not.toHaveBeenCalled();
      expect(hook.result.current.deleteState).toBe("idle");
      expect(hook.result.current.deleteError).toBe(DELETED_ELSEWHERE_MESSAGE);
      expect(await storedBinding()).toEqual({ ...BOUND, ...switched });
      expect(await isSelfDepartureActive()).toBe(false);
    },
  );

  it.each<[string, Record<string, string>]>([
    ["storage is unchanged", {}],
    [
      "only the stored server changed",
      { [API_ENDPOINT_KEY]: "https://x.example" },
    ],
  ])("clears storage and calls onLeave when %s", async (_label, changed) => {
    const { hook, onLeave, confirmDelete } = setup(async () => {
      await chrome.storage.local.set(changed);
      return { data: { ok: true } };
    });

    await confirmDelete();

    expect(chrome.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
    expect(await chrome.storage.local.get(null)).toEqual({});
  });

  it("clears storage and calls onLeave when another tab left the family mid-delete", async () => {
    const { hook, onLeave, confirmDelete } = setup(async () => {
      await chrome.storage.local.remove(FAMILY_ID_KEY);
      return { data: { ok: true } };
    });

    await confirmDelete();

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(FAMILY_ID_KEY);
    expect(chrome.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
    expect(await chrome.storage.local.get(null)).toEqual({});
    expect(await isSelfDepartureActive()).toBe(false);
  });

  it("clears storage and calls onLeave when the binding read rejects", async () => {
    const get = vi.mocked(chrome.storage.local.get);
    const storeGet = get.getMockImplementation()!;
    const readStore = storeGet as (keys: unknown) => unknown;
    let rejected = 0;
    get.mockImplementation(((keys: unknown) => {
      const isBindingRead =
        Array.isArray(keys) &&
        keys.length === 2 &&
        keys.includes(USER_ID_KEY) &&
        keys.includes(FAMILY_ID_KEY);
      if (!isBindingRead) return readStore(keys);
      rejected += 1;
      return Promise.reject(new Error("Extension context invalidated"));
    }) as never);
    const { hook, onLeave, confirmDelete } = setup(async () => ({
      data: { ok: true },
    }));

    try {
      await confirmDelete();
    } finally {
      get.mockImplementation(storeGet);
    }

    expect(rejected).toBe(1);
    expect(chrome.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(hook.result.current.deleteError).toBe("");
    expect(await chrome.storage.local.get(null)).toEqual({});
  });

  it("pins the stale-window copy", () => {
    expect(DELETED_ELSEWHERE_MESSAGE).toBe(
      "帳戶已移除。這個視窗的資料已過期，請關閉後重新開啟。",
    );
  });
});
