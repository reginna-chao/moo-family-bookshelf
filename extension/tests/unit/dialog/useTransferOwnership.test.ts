import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";
import { DEFAULT_API_ENDPOINT } from "@/constants";
import { DEPARTURE_SERVER_CHANGED_MESSAGE } from "@/dialog/departureServerPin";
import { useTransferOwnership } from "@/dialog/useTransferOwnership";
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";

/**
 * useTransferOwnership — the flow behind MemberList's 轉移管理權 confirm.
 *
 * `start` lets the caller clear its old error (`onStart`), then reads the verify method once: a PIN /
 * pattern account is asked for its current secret (`secretMethod`) and nothing is sent yet; any other
 * answer, or a failed read, sends the transfer at once without a secret. `submitSecret` sends the
 * transfer with the secret as `transferOwnership`'s fifth argument, together with the endpoint choice
 * made on the confirm screen (`clearEndpoint`, Extension-only).
 *
 * Refusals go through `recoverStepUp`: a wrong secret keeps the secret step with the method's
 * wrong-secret copy; `VERIFICATION_REQUIRED` re-reads the method and either asks for the secret or —
 * when the account no longer has one — goes back to the confirm screen with `notice`. Every other
 * refusal and any throw reaches `onFailed` (the Extension's caller then closes the confirm).
 *
 * The secret is a call argument only, never written to `browser.storage.local`.
 *
 * Pinned server: `start` pins `apiClient.getEndpoint()` before its first await and the run never leaves
 * it. Once the endpoint differs (`moveServer`; by default to `DEFAULT_API_ENDPOINT`, which is where a
 * family-tree teardown resets the client), the next step is not sent — no transfer, no secret, no method
 * re-read — and `onFailed` gets `DEPARTURE_SERVER_CHANGED_MESSAGE`. The cases that never move the
 * endpoint are the positive companions: the same steps run through to their next request.
 * Twin: `pwa/tests/unit/hooks/useTransferOwnership.test.ts`.
 */

type TransferRes = Awaited<ReturnType<ApiClient["transferOwnership"]>>;
type MethodRead = VerifyMethod | null | "throw";

const OK = { data: { familyId: "fam-1" } } as TransferRes;
const WRONG_SECRET: TransferRes = {
  error: { code: "VERIFICATION_FAILED", message: "server text" },
};
const SECRET_REQUIRED: TransferRes = {
  error: { code: "VERIFICATION_REQUIRED", message: "server text" },
};

const FAMILY_SERVER = "https://family.example";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Each `getVerifyMethod` call takes the next of `methods` (null: an error envelope; "throw": a
 *  rejection); each `transferOwnership` call the next of `responses`. */
function setup(
  methods: MethodRead[],
  responses: Array<TransferRes | Promise<TransferRes>>,
) {
  const getVerifyMethod = vi.fn(async () => {
    const method = methods.shift();
    if (method === "throw") throw new Error("offline");
    if (method === null || method === undefined) {
      return { error: { code: "SERVER_ERROR", message: "boom" } };
    }
    return { data: { method } };
  });
  const transferOwnership = vi.fn<
    (
      familyId: string,
      userId: string,
      newOwnerId: string,
      clearEndpoint?: 1,
      currentSecret?: string,
    ) => Promise<TransferRes>
  >(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected transfer");
    return next;
  });
  const onStart = vi.fn();
  const onTransferred = vi.fn();
  const onFailed = vi.fn();
  let endpoint = FAMILY_SERVER;
  const moveServer = (to: string = DEFAULT_API_ENDPOINT) => {
    endpoint = to;
  };
  const apiClient = {
    getVerifyMethod,
    transferOwnership,
    getEndpoint: () => endpoint,
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useTransferOwnership({
      familyId: "fam-1",
      userId: "user-1",
      targetId: "user-2",
      apiClient,
      onStart,
      onTransferred,
      onFailed,
    }),
  );
  const start = (clearEndpoint?: 1, action?: "keep" | "clear") =>
    act(async () => {
      await hook.result.current.start(clearEndpoint, action);
    });
  const submit = (secret: string) =>
    act(async () => {
      await hook.result.current.submitSecret(secret);
    });
  return {
    hook,
    getVerifyMethod,
    transferOwnership,
    onStart,
    onTransferred,
    onFailed,
    start,
    submit,
    moveServer,
  };
}

/** True when any `browser.storage.local.set` call so far carried `secret`. */
function storageSawSecret(secret: string): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some((call) => JSON.stringify(call[0]).includes(secret));
}

describe("useTransferOwnership", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it("lets the caller clear its error, then reads the method once", async () => {
    const { getVerifyMethod, onStart, start } = setup(["none"], [OK]);

    await start();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(getVerifyMethod).toHaveBeenCalledWith("user-1");
  });

  it.each<[string, MethodRead]>([
    ["a none account", "none"],
    ["a code account", "code"],
    ["a failed method read", null],
    ["a rejected method read", "throw"],
  ])("transfers without a secret for %s", async (_label, method) => {
    const { hook, transferOwnership, onTransferred, onFailed, start } = setup(
      [method],
      [OK],
    );

    await start();

    expect(transferOwnership).toHaveBeenCalledTimes(1);
    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      undefined,
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(hook.result.current.secretMethod).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it("stays loading while the transfer is in flight, with the pressed action marked", async () => {
    const pending = deferred<TransferRes>();
    const { hook, transferOwnership, onTransferred } = setup(
      ["none"],
      [pending.promise],
    );

    let started!: Promise<void>;
    act(() => {
      started = hook.result.current.start(undefined, "keep");
    });
    await waitFor(() => expect(transferOwnership).toHaveBeenCalledTimes(1));

    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.activeAction).toBe("keep");
    expect(onTransferred).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(OK);
      await started;
    });
    expect(hook.result.current.loading).toBe(false);
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it.each<VerifyMethod>(["pin", "pattern"])(
    "asks a %s account for its current secret before sending anything",
    async (method) => {
      const { hook, transferOwnership, start } = setup([method], []);

      await start(undefined, "keep");

      expect(transferOwnership).not.toHaveBeenCalled();
      expect(hook.result.current.secretMethod).toBe(method);
      expect(hook.result.current.secretError).toBe("");
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.activeAction).toBeNull();
    },
  );

  it("sends the secret with the transfer, stays loading meanwhile, and never stores it", async () => {
    const pending = deferred<TransferRes>();
    const { hook, transferOwnership, onTransferred, start } = setup(
      ["pin"],
      [pending.promise],
    );
    await start();

    let submitted!: Promise<void>;
    act(() => {
      submitted = hook.result.current.submitSecret("482913");
    });
    expect(hook.result.current.loading).toBe(true);
    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      "482913",
    );

    await act(async () => {
      pending.resolve(OK);
      await submitted;
    });
    expect(hook.result.current.loading).toBe(false);
    expect(onTransferred).toHaveBeenCalledTimes(1);
    // Positive companion: the spy records writes made in this environment.
    await chrome.storage.local.set({ probe: "visible" });
    expect(storageSawSecret("visible")).toBe(true);
    expect(storageSawSecret("482913")).toBe(false);
  });

  it.each<[1 | undefined, "keep" | "clear"]>([
    [1, "clear"],
    [undefined, "keep"],
  ])(
    "forwards clearEndpoint=%s chosen on the confirm screen after the secret step",
    async (clearEndpoint, action) => {
      const { transferOwnership, start, submit } = setup(["pattern"], [OK]);

      await start(clearEndpoint, action);
      await submit("0,3,6,7");

      expect(transferOwnership).toHaveBeenCalledTimes(1);
      expect(transferOwnership).toHaveBeenCalledWith(
        "fam-1",
        "user-1",
        "user-2",
        clearEndpoint,
        "0,3,6,7",
      );
    },
  );

  it.each<[VerifyMethod, string, string]>([
    ["pin", "000000", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", "0,1,2,5", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "keeps the %s secret step with the wrong-secret copy after a wrong secret",
    async (method, secret, message) => {
      const { hook, getVerifyMethod, onFailed, onTransferred, start, submit } =
        setup([method], [WRONG_SECRET]);

      await start();
      await submit(secret);

      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.secretMethod).toBe(method);
      expect(hook.result.current.secretError).toBe(message);
      expect(hook.result.current.notice).toBe("");
      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
      expect(onTransferred).not.toHaveBeenCalled();
      expect(storageSawSecret(secret)).toBe(false);
    },
  );

  it("bumps secretAttempt once per refused secret, never on start or success", async () => {
    const { hook, start, submit } = setup(["pin"], [WRONG_SECRET, OK]);
    expect(hook.result.current.secretAttempt).toBe(0);

    await start();
    expect(hook.result.current.secretAttempt).toBe(0);
    await submit("000000");
    expect(hook.result.current.secretAttempt).toBe(1);
    await submit("482913");

    expect(hook.result.current.secretAttempt).toBe(1);
  });

  it("bumps secretAttempt when the transfer request throws", async () => {
    const { hook, transferOwnership, start, submit } = setup(["pin"], []);
    transferOwnership.mockRejectedValueOnce(new Error("Network down"));

    await start();
    await submit("482913");

    expect(hook.result.current.secretAttempt).toBe(1);
  });

  it("clears the wrong-secret copy when the next secret is sent, then transfers", async () => {
    const { hook, transferOwnership, onTransferred, start, submit } = setup(
      ["pin"],
      [WRONG_SECRET, OK],
    );

    await start();
    await submit("000000");
    await submit("482913");

    expect(transferOwnership).toHaveBeenLastCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      "482913",
    );
    expect(hook.result.current.secretError).toBe("");
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("asks for the secret, without an error, when the server requires one the first read missed", async () => {
    const { hook, getVerifyMethod, transferOwnership, onFailed, start } = setup(
      ["throw", "pin"],
      [SECRET_REQUIRED],
    );

    await start();

    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      undefined,
    );
    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.secretMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.loading).toBe(false);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says the sent secret could not be checked when the server still requires one", async () => {
    const { hook, onFailed, start, submit } = setup(
      ["pin", "pin"],
      [SECRET_REQUIRED],
    );

    await start();
    await submit("482913");

    expect(hook.result.current.secretMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each<[string, MethodRead[], boolean]>([
    ["no secret was sent", ["none", "none"], false],
    ["the account dropped its PIN meanwhile", ["pin", "none"], true],
  ])(
    "goes back to the confirm screen with the notice when VERIFICATION_REQUIRED and %s",
    async (_label, methods, sendsSecret) => {
      const { hook, onFailed, onTransferred, start, submit } = setup(methods, [
        SECRET_REQUIRED,
      ]);

      await start(1, "clear");
      if (sendsSecret) await submit("482913");

      expect(hook.result.current.secretMethod).toBeNull();
      expect(hook.result.current.notice).toBe(
        CURRENT_SECRET_UNAVAILABLE_MESSAGE,
      );
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.activeAction).toBeNull();
      expect(onFailed).not.toHaveBeenCalled();
      expect(onTransferred).not.toHaveBeenCalled();
    },
  );

  it("clears the notice when the next attempt starts", async () => {
    const { hook, start } = setup(
      ["none", "none", "none"],
      [SECRET_REQUIRED, OK],
    );

    await start();
    expect(hook.result.current.notice).toBe(CURRENT_SECRET_UNAVAILABLE_MESSAGE);
    await start();

    expect(hook.result.current.notice).toBe("");
  });

  it.each<[string, TransferRes, string]>([
    [
      "a server message",
      { error: { code: "FORBIDDEN", message: "權限不足" } },
      "權限不足",
    ],
    [
      "an empty server message",
      { error: { code: "SERVER_ERROR", message: "" } },
      "轉移管理權失敗，請稍後再試",
    ],
    [
      "RATE_LIMITED with a wait",
      { error: { code: "RATE_LIMITED", message: "slow", retryAfter: 45 } },
      rateLimitedMessage(45),
    ],
    [
      "RATE_LIMITED without a wait",
      { error: { code: "RATE_LIMITED", message: "Too Many Requests" } },
      rateLimitedMessage(null),
    ],
  ])(
    "hands the copy for %s to onFailed",
    async (_label, response, expected) => {
      const { hook, onFailed, onTransferred, start } = setup(
        ["none"],
        [response],
      );

      await start(undefined, "keep");

      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onFailed).toHaveBeenCalledWith(expected);
      expect(onTransferred).not.toHaveBeenCalled();
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.activeAction).toBeNull();
    },
  );

  it("hands the lock copy, not the server's text, to onFailed when the secret is locked out", async () => {
    const { onFailed, start, submit } = setup(
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
    await submit("482913");

    expect(onFailed).toHaveBeenCalledWith(verificationLockedMessage(900));
  });

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Network down"), "Network down"],
    ["a non-Error value", "boom", "發生未知錯誤"],
  ])(
    "hands the error to onFailed when the request throws %s",
    async (_label, thrown, expected) => {
      const { hook, transferOwnership, onFailed, start } = setup(["none"], []);
      transferOwnership.mockRejectedValueOnce(thrown);

      await start(1, "clear");

      expect(onFailed).toHaveBeenCalledWith(expected);
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.activeAction).toBeNull();
    },
  );

  it("reset leaves the secret step and clears its error", async () => {
    const { hook, start, submit } = setup(["pin"], [WRONG_SECRET]);

    await start();
    await submit("000000");
    act(() => hook.result.current.reset());

    expect(hook.result.current.secretMethod).toBeNull();
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.notice).toBe("");
    expect(hook.result.current.loading).toBe(false);
  });

  describe("when the server changes mid-run", () => {
    type MethodReply = { data: { method: VerifyMethod } };

    function expectStopped(ctx: ReturnType<typeof setup>) {
      expect(ctx.transferOwnership).not.toHaveBeenCalled();
      expect(ctx.onFailed).toHaveBeenCalledTimes(1);
      expect(ctx.onFailed).toHaveBeenCalledWith(
        DEPARTURE_SERVER_CHANGED_MESSAGE,
      );
      expect(ctx.onTransferred).not.toHaveBeenCalled();
      expect(ctx.hook.result.current.loading).toBe(false);
      expect(ctx.hook.result.current.activeAction).toBeNull();
    }

    /** Start with the method read held open, move the server, then let `settle` answer the read. */
    async function moveDuringMethodRead(
      settle: (read: ReturnType<typeof deferred<MethodReply>>) => void,
    ) {
      const ctx = setup([], [OK]);
      const read = deferred<MethodReply>();
      ctx.getVerifyMethod.mockImplementationOnce(() => read.promise as never);
      let started!: Promise<void>;
      act(() => {
        started = ctx.hook.result.current.start(undefined, "keep");
      });
      expect(ctx.getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(ctx.hook.result.current.loading).toBe(true);
      ctx.moveServer();
      await act(async () => {
        settle(read);
        await started;
      });
      return ctx;
    }

    it.each<[string, (read: ReturnType<typeof deferred<MethodReply>>) => void]>(
      [
        ["resolves none", (read) => read.resolve({ data: { method: "none" } })],
        ["rejects", (read) => read.reject(new Error("offline"))],
      ],
    )(
      "sends no transfer when the late method read %s",
      async (_label, settle) => {
        const ctx = await moveDuringMethodRead(settle);

        expectStopped(ctx);
        expect(ctx.hook.result.current.secretMethod).toBeNull();
      },
    );

    it("shows no secret step and sends nothing when the late method read is pin", async () => {
      const ctx = await moveDuringMethodRead((read) =>
        read.resolve({ data: { method: "pin" } }),
      );

      expectStopped(ctx);
      expect(ctx.hook.result.current.secretMethod).toBeNull();
    });

    it("sends no secret when the server moves while the secret step is shown", async () => {
      const ctx = setup(["pin"], [OK]);
      await ctx.start(1, "clear");
      expect(ctx.hook.result.current.secretMethod).toBe("pin");

      ctx.moveServer();
      await ctx.submit("1234");

      expectStopped(ctx);
      expect(storageSawSecret("1234")).toBe(false);
    });

    it("does not re-read the method when VERIFICATION_REQUIRED lands after the move", async () => {
      const pending = deferred<TransferRes>();
      const ctx = setup(["none", "pin"], [pending.promise]);
      let started!: Promise<void>;
      act(() => {
        started = ctx.hook.result.current.start(undefined, "keep");
      });
      await waitFor(() =>
        expect(ctx.transferOwnership).toHaveBeenCalledTimes(1),
      );

      ctx.moveServer();
      await act(async () => {
        pending.resolve(SECRET_REQUIRED);
        await started;
      });

      expect(ctx.getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(ctx.transferOwnership).toHaveBeenCalledTimes(1);
      expect(ctx.onFailed).toHaveBeenCalledWith(
        DEPARTURE_SERVER_CHANGED_MESSAGE,
      );
      expect(ctx.onTransferred).not.toHaveBeenCalled();
      expect(ctx.hook.result.current.secretMethod).toBeNull();
      expect(ctx.hook.result.current.loading).toBe(false);
      expect(ctx.hook.result.current.activeAction).toBeNull();
    });

    it("pins the new server on a fresh start after reset and transfers there", async () => {
      const ctx = setup(["pin", "none"], [OK]);
      await ctx.start();
      ctx.moveServer();
      act(() => ctx.hook.result.current.reset());

      await ctx.start(undefined, "keep");

      expect(ctx.transferOwnership).toHaveBeenCalledTimes(1);
      expect(ctx.transferOwnership).toHaveBeenCalledWith(
        "fam-1",
        "user-1",
        "user-2",
        undefined,
        undefined,
      );
      expect(ctx.onTransferred).toHaveBeenCalledTimes(1);
      expect(ctx.onFailed).not.toHaveBeenCalled();
    });

    it("sends nothing when a secret is submitted after reset", async () => {
      const ctx = setup(["pin"], [OK]);
      await ctx.start();
      act(() => ctx.hook.result.current.reset());

      await ctx.submit("1234");

      expect(ctx.transferOwnership).not.toHaveBeenCalled();
      expect(ctx.onFailed).not.toHaveBeenCalled();
    });
  });
});
