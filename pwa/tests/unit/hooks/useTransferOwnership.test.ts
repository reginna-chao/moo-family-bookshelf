import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import type { ApiClient, VerifyMethod } from "@/api/client";
import { useTransferOwnership } from "@/hooks/useTransferOwnership";
import {
  buildRetryMessage,
  rateLimitedEnvelopeMessage,
} from "@/utils/retryMessage";
import { expectSecretNotStored } from "../../helpers/secretStorage";

/**
 * useTransferOwnership — MemberList's 轉移管理權 flow with the current-secret step. Twin:
 * `extension/tests/unit/dialog/useTransferOwnership.test.ts` (the Extension adds clearEndpoint,
 * activeAction and notice).
 *
 * `start` calls `onStart` (the caller clears its old error), then reads the verify method once: a
 * PIN / pattern account is asked for its current secret (`secretMethod`), any other answer — or a
 * failed read — sends the transfer without one. `submitSecret` sends the entered secret as a
 * parameter only. `loading` is true from `start` / `submitSecret` until the outcome is settled.
 *
 * Refusals go through `recoverStepUp`: a wrong secret stays on the secret step with the wrong-secret
 * copy (no `onFailed`); `VERIFICATION_REQUIRED` re-reads the method and either asks (PIN / pattern)
 * or hands `CURRENT_SECRET_UNAVAILABLE_MESSAGE` to `onFailed`; a 429 hands over the back-off copy;
 * any other refusal hands over the server's text or the local fallback, and the secret step closes.
 */

type TransferRes = ApiResponse<{ ok: boolean }>;

const FAMILY_ID = "fam-1";
const USER_ID = "a".repeat(64);
const TARGET_ID = "b".repeat(64);
const SECRET = "975310";
const FALLBACK = "轉移管理權失敗，請稍後再試";

function readAnswer(m: VerifyMethod | Error) {
  return m instanceof Error
    ? Promise.reject(m)
    : Promise.resolve({ data: { method: m } });
}

function setup(
  method: VerifyMethod | Error,
  transfer: () => Promise<TransferRes>,
  reread?: VerifyMethod,
) {
  const getVerifyMethod = vi
    .fn()
    .mockImplementationOnce(() => readAnswer(method))
    .mockImplementation(() => readAnswer(reread ?? "none"));
  const transferOwnership = vi.fn(transfer);
  const onStart = vi.fn();
  const onTransferred = vi.fn();
  const onFailed = vi.fn();
  const apiClient = {
    getVerifyMethod,
    transferOwnership,
  } as unknown as ApiClient;
  const hook = renderHook(() =>
    useTransferOwnership({
      familyId: FAMILY_ID,
      userId: USER_ID,
      targetId: TARGET_ID,
      apiClient,
      onStart,
      onTransferred,
      onFailed,
    }),
  );
  return {
    hook,
    getVerifyMethod,
    transferOwnership,
    onStart,
    onTransferred,
    onFailed,
  };
}

type Hook = ReturnType<typeof setup>["hook"];

const resolves = (res: TransferRes) => () => Promise.resolve(res);
const OK: TransferRes = { data: { ok: true } };

function refusal(code: string, extra: Record<string, unknown> = {}) {
  return resolves({
    error: { code, message: "server text", ...extra },
  } as TransferRes);
}

async function start(hook: Hook) {
  await act(async () => {
    await hook.result.current.start();
  });
}

async function submit(hook: Hook, secret = SECRET) {
  await act(async () => {
    await hook.result.current.submitSecret(secret);
  });
}

/** A transfer whose answer the test releases by hand, to observe the in-flight state. */
function deferred() {
  let release: (res: TransferRes) => void = () => {};
  const promise = new Promise<TransferRes>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("useTransferOwnership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle on the confirm screen", () => {
    const { hook } = setup("none", resolves(OK));

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.secretMethod).toBeNull();
    expect(hook.result.current.secretError).toBe("");
  });

  it.each<[string, VerifyMethod | Error]>([
    ["a none account", "none"],
    ["a code account", "code"],
    ["a failed method read", new Error("network")],
  ])(
    "sends at once without a secret for %s and reports the transfer",
    async (_l, method) => {
      const {
        hook,
        getVerifyMethod,
        transferOwnership,
        onTransferred,
        onFailed,
      } = setup(method, resolves(OK));

      await start(hook);

      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(getVerifyMethod).toHaveBeenCalledWith(USER_ID);
      expect(transferOwnership).toHaveBeenCalledTimes(1);
      expect(transferOwnership).toHaveBeenCalledWith(
        FAMILY_ID,
        USER_ID,
        TARGET_ID,
        undefined,
      );
      expect(onTransferred).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
      expect(hook.result.current.secretMethod).toBeNull();
      expect(hook.result.current.loading).toBe(false);
    },
  );

  it("calls onStart before the method read", async () => {
    const order: string[] = [];
    const { hook, getVerifyMethod, onStart } = setup("none", resolves(OK));
    onStart.mockImplementation(() => order.push("onStart"));
    getVerifyMethod.mockReset();
    getVerifyMethod.mockImplementation(() => {
      order.push("read");
      return readAnswer("none");
    });

    await start(hook);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["onStart", "read"]);
  });

  it.each<VerifyMethod>(["pin", "pattern"])(
    "asks a %s account for its current secret and sends nothing yet",
    async (method) => {
      const { hook, transferOwnership, onTransferred, onFailed } = setup(
        method,
        resolves(OK),
      );

      await start(hook);

      expect(hook.result.current.secretMethod).toBe(method);
      expect(hook.result.current.secretError).toBe("");
      expect(hook.result.current.loading).toBe(false);
      expect(transferOwnership).not.toHaveBeenCalled();
      expect(onTransferred).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
    },
  );

  it("sends the entered secret and reports the transfer", async () => {
    const { hook, transferOwnership, onTransferred, onFailed } = setup(
      "pin",
      resolves(OK),
    );
    await start(hook);

    await submit(hook);

    expect(transferOwnership).toHaveBeenCalledTimes(1);
    expect(transferOwnership).toHaveBeenCalledWith(
      FAMILY_ID,
      USER_ID,
      TARGET_ID,
      SECRET,
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(false);
    expectSecretNotStored(SECRET);
  });

  it("is loading while the method read is in flight", async () => {
    let answer: (v: unknown) => void = () => {};
    const { hook, getVerifyMethod } = setup("pin", resolves(OK));
    getVerifyMethod.mockReset();
    getVerifyMethod.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.start();
    });
    expect(hook.result.current.loading).toBe(true);

    await act(async () => {
      answer({ data: { method: "pin" } });
      await pending;
    });
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.secretMethod).toBe("pin");
  });

  it("is loading while a no-secret transfer is in flight", async () => {
    const gate = deferred();
    const { hook, onTransferred } = setup("none", () => gate.promise);

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = hook.result.current.start();
      // Let the method read settle so the transfer itself is what is pending.
      await Promise.resolve();
    });
    expect(hook.result.current.loading).toBe(true);
    expect(onTransferred).not.toHaveBeenCalled();

    await act(async () => {
      gate.release(OK);
      await pending;
    });
    expect(hook.result.current.loading).toBe(false);
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("is loading while the secret is being sent", async () => {
    const gate = deferred();
    const { hook } = setup("pin", () => gate.promise);
    await start(hook);

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.submitSecret(SECRET);
    });
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.secretMethod).toBe("pin");

    await act(async () => {
      gate.release(OK);
      await pending;
    });
    expect(hook.result.current.loading).toBe(false);
  });

  it.each<[VerifyMethod, string]>([
    ["pin", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "keeps a %s account on the secret step with the wrong-secret copy",
    async (method, copy) => {
      const { hook, onTransferred, onFailed } = setup(
        method,
        refusal("VERIFICATION_FAILED"),
      );
      await start(hook);

      await submit(hook);

      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.secretMethod).toBe(method);
      expect(hook.result.current.secretError).toBe(copy);
      expect(onFailed).not.toHaveBeenCalled();
      expect(onTransferred).not.toHaveBeenCalled();
    },
  );

  it("bumps secretAttempt once per refused secret, never on start or success", async () => {
    const answers: Array<() => Promise<TransferRes>> = [
      refusal("VERIFICATION_FAILED"),
      resolves(OK),
    ];
    const { hook } = setup("pin", () => answers.shift()!());
    expect(hook.result.current.secretAttempt).toBe(0);

    await start(hook);
    expect(hook.result.current.secretAttempt).toBe(0);
    await submit(hook, "000000");
    expect(hook.result.current.secretAttempt).toBe(1);
    await submit(hook);

    expect(hook.result.current.secretAttempt).toBe(1);
  });

  it("bumps secretAttempt when the transfer request throws", async () => {
    const { hook } = setup("pin", () =>
      Promise.reject(new Error("Failed to fetch")),
    );
    await start(hook);

    await submit(hook);

    expect(hook.result.current.secretAttempt).toBe(1);
  });

  it("clears the previous wrong-secret copy when the secret is sent again", async () => {
    const gate = deferred();
    const answers: Array<() => Promise<TransferRes>> = [
      refusal("VERIFICATION_FAILED"),
      () => gate.promise,
    ];
    const { hook, onTransferred } = setup("pin", () => answers.shift()!());
    await start(hook);
    await submit(hook, "000000");
    expect(hook.result.current.secretError).toBe(CURRENT_PIN_WRONG_MESSAGE);

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = hook.result.current.submitSecret(SECRET);
    });
    // Cleared as the retry starts, before any answer arrives.
    expect(hook.result.current.secretError).toBe("");
    await act(async () => {
      gate.release(OK);
      await pending;
    });
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("asks without an error when VERIFICATION_REQUIRED re-reads a PIN after no secret was sent", async () => {
    const { hook, getVerifyMethod, onFailed } = setup(
      "none",
      refusal("VERIFICATION_REQUIRED"),
      "pin",
    );

    await start(hook);

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.secretMethod).toBe("pin");
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.loading).toBe(false);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("asks with the unavailable copy when a sent secret meets VERIFICATION_REQUIRED", async () => {
    const { hook, onFailed } = setup(
      "pin",
      refusal("VERIFICATION_REQUIRED"),
      "pattern",
    );
    await start(hook);

    await submit(hook);

    expect(hook.result.current.secretMethod).toBe("pattern");
    expect(hook.result.current.secretError).toBe(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("hands the unavailable copy to onFailed when the re-read is not PIN / pattern", async () => {
    const { hook, onFailed, onTransferred } = setup(
      "pin",
      refusal("VERIFICATION_REQUIRED"),
      "code",
    );
    await start(hook);

    await submit(hook);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(CURRENT_SECRET_UNAVAILABLE_MESSAGE);
    expect(onTransferred).not.toHaveBeenCalled();
    expect(hook.result.current.secretMethod).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it("stays loading until the VERIFICATION_REQUIRED re-read returns", async () => {
    const { hook, getVerifyMethod } = setup(
      "pin",
      refusal("VERIFICATION_REQUIRED"),
    );
    await start(hook);
    let answer: (v: unknown) => void = () => {};
    getVerifyMethod.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = hook.result.current.submitSecret(SECRET);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(hook.result.current.loading).toBe(true);

    await act(async () => {
      answer({ data: { method: "pin" } });
      await pending;
    });
    expect(hook.result.current.loading).toBe(false);
  });

  it.each<[string, () => Promise<TransferRes>, string]>([
    [
      "VERIFICATION_LOCKED",
      refusal("VERIFICATION_LOCKED", { retryAfter: 90 }),
      buildRetryMessage("VERIFICATION_LOCKED", 90),
    ],
    [
      "RATE_LIMITED with a wait",
      refusal("RATE_LIMITED", { retryAfter: 30 }),
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED", retryAfter: 30 })!,
    ],
    [
      "RATE_LIMITED without a wait",
      refusal("RATE_LIMITED"),
      rateLimitedEnvelopeMessage({ code: "RATE_LIMITED" })!,
    ],
    [
      "a server message",
      resolves({ error: { code: "NOT_OWNER", message: "只有管理者可以轉移" } }),
      "只有管理者可以轉移",
    ],
    [
      "an empty server message",
      resolves({ error: { code: "SERVER_ERROR", message: "" } }),
      FALLBACK,
    ],
    [
      "an object server message",
      resolves({
        error: { code: "SERVER_ERROR", message: { zh: "壞掉了" } },
      } as unknown as TransferRes),
      FALLBACK,
    ],
  ])(
    "closes the secret step and hands %s to onFailed",
    async (_l, transfer, expected) => {
      const { hook, onFailed, onTransferred } = setup("pin", transfer);
      await start(hook);

      await submit(hook);

      expect(onFailed).toHaveBeenCalledTimes(1);
      expect(onFailed).toHaveBeenCalledWith(expected);
      expect(onTransferred).not.toHaveBeenCalled();
      expect(hook.result.current.secretMethod).toBeNull();
      expect(hook.result.current.loading).toBe(false);
    },
  );

  it("never shows the server's English text for a 429", async () => {
    const { hook, onFailed } = setup(
      "none",
      resolves({
        error: { code: "RATE_LIMITED", message: "Too Many Requests" },
      }),
    );

    await start(hook);

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).not.toContain("Too Many Requests");
    // Static variant (no retryAfter) — pinned in tests/unit/retryMessage.test.ts.
    expect(onFailed).toHaveBeenCalledWith("嘗試次數過多，請稍後再試");
  });

  it.each<[string, unknown, string]>([
    ["an Error", new Error("Failed to fetch"), "Failed to fetch"],
    ["a non-Error value", "boom", "操作失敗"],
  ])(
    "hands the thrown %s to onFailed and stops loading",
    async (_l, thrown, expected) => {
      const { hook, onFailed, onTransferred } = setup("none", () =>
        Promise.reject(thrown),
      );

      await start(hook);

      expect(onFailed).toHaveBeenCalledWith(expected);
      expect(onTransferred).not.toHaveBeenCalled();
      expect(hook.result.current.loading).toBe(false);
    },
  );

  it("reset leaves the secret step and clears its error", async () => {
    const { hook } = setup("pin", refusal("VERIFICATION_FAILED"));
    await start(hook);
    await submit(hook);
    expect(hook.result.current.secretError).toBe(CURRENT_PIN_WRONG_MESSAGE);

    act(() => {
      hook.result.current.reset();
    });

    expect(hook.result.current.secretMethod).toBeNull();
    expect(hook.result.current.secretError).toBe("");
    expect(hook.result.current.loading).toBe(false);
  });
});
