import { describe, it, expect, vi } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient, VerifyMethod } from "@/api/client";
import {
  readVerifyMethod,
  recoverStepUp,
  stepUpBackoffMessage,
} from "@/hooks/stepUp";
import { buildRetryMessage } from "@/utils/retryMessage";

/**
 * stepUp — the PWA's shared decisions after a refused verify change or account deletion (#396). Twin:
 * extension/src/dialog/stepUp.ts. The callers' state handling is covered by
 * VerifySetupPrompt.stepUpErrors.test.tsx and useDeleteAccount.stepUp.test.ts; this file pins the
 * edge inputs: unusable `retryAfter` values degrade to the static copy, `VERIFICATION_FAILED` without
 * a sent secret is not a step-up, and the re-read happens exactly once.
 */

const USER_ID = "c".repeat(64);

function clientReading(...answers: Array<VerifyMethod | Error>) {
  const getVerifyMethod = vi.fn();
  for (const a of answers) {
    getVerifyMethod.mockImplementationOnce(() =>
      a instanceof Error
        ? Promise.reject(a)
        : Promise.resolve({ data: { method: a } }),
    );
  }
  return { getVerifyMethod } as unknown as ApiClient & {
    getVerifyMethod: typeof getVerifyMethod;
  };
}

describe("stepUpBackoffMessage", () => {
  it.each<[string, { code: string; retryAfter?: number }, string | null]>([
    [
      "a locked wait",
      { code: "VERIFICATION_LOCKED", retryAfter: 90 },
      buildRetryMessage("VERIFICATION_LOCKED", 90),
    ],
    [
      "a locked NaN wait",
      { code: "VERIFICATION_LOCKED", retryAfter: NaN },
      buildRetryMessage("VERIFICATION_LOCKED", 0),
    ],
    [
      "a locked infinite wait",
      { code: "VERIFICATION_LOCKED", retryAfter: Infinity },
      buildRetryMessage("VERIFICATION_LOCKED", 0),
    ],
    [
      "a locked negative wait",
      { code: "VERIFICATION_LOCKED", retryAfter: -5 },
      buildRetryMessage("VERIFICATION_LOCKED", 0),
    ],
    [
      "a locked missing wait",
      { code: "VERIFICATION_LOCKED" },
      buildRetryMessage("VERIFICATION_LOCKED", 0),
    ],
    [
      "a rate-limit wait",
      { code: "RATE_LIMITED", retryAfter: 30 },
      buildRetryMessage("RATE_LIMITED", 30),
    ],
    ["any other code", { code: "SERVER_ERROR", retryAfter: 30 }, null],
  ])("maps %s", (_label, error, expected) => {
    expect(stepUpBackoffMessage(error)).toBe(expected);
  });
});

describe("readVerifyMethod", () => {
  it.each<[string, () => Promise<unknown>, VerifyMethod | null]>([
    [
      "a method",
      () => Promise.resolve({ data: { method: "pattern" } }),
      "pattern",
    ],
    [
      "an error envelope",
      () => Promise.resolve({ error: { code: "X", message: "x" } }),
      null,
    ],
    ["a rejected read", () => Promise.reject(new Error("network")), null],
  ])("returns the method or null for %s", async (_label, read, expected) => {
    const apiClient = { getVerifyMethod: vi.fn(read) } as unknown as ApiClient;

    expect(await readVerifyMethod(apiClient, USER_ID)).toBe(expected);
  });
});

describe("recoverStepUp", () => {
  it.each<[VerifyMethod, string]>([
    ["pin", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "asks again for the %s after VERIFICATION_FAILED, without a re-read",
    async (method, copy) => {
      const client = clientReading();

      const next = await recoverStepUp(
        client,
        USER_ID,
        { code: "VERIFICATION_FAILED" },
        method,
      );

      expect(next).toStrictEqual({ kind: "ask", method, error: copy });
      expect(client.getVerifyMethod).not.toHaveBeenCalled();
    },
  );

  it("leaves VERIFICATION_FAILED to the caller when no secret was sent", async () => {
    const next = await recoverStepUp(
      clientReading(),
      USER_ID,
      { code: "VERIFICATION_FAILED" },
      null,
    );

    expect(next).toBeNull();
  });

  it.each<[string, VerifyMethod | Error, unknown]>([
    ["a pin", "pin", { kind: "ask", method: "pin", error: "" }],
    ["a pattern", "pattern", { kind: "ask", method: "pattern", error: "" }],
    [
      "a code",
      "code",
      { kind: "message", error: CURRENT_SECRET_UNAVAILABLE_MESSAGE },
    ],
    [
      "a failed read",
      new Error("network"),
      { kind: "message", error: CURRENT_SECRET_UNAVAILABLE_MESSAGE },
    ],
  ])(
    "re-reads once after VERIFICATION_REQUIRED and maps %s",
    async (_label, reread, expected) => {
      const client = clientReading(reread);

      const next = await recoverStepUp(
        client,
        USER_ID,
        { code: "VERIFICATION_REQUIRED" },
        null,
      );

      expect(next).toStrictEqual(expected);
      expect(client.getVerifyMethod).toHaveBeenCalledTimes(1);
      expect(client.getVerifyMethod).toHaveBeenCalledWith(USER_ID);
    },
  );

  it.each<VerifyMethod>(["pin", "pattern"])(
    "asks again with the unavailable copy when a sent %s meets VERIFICATION_REQUIRED",
    async (method) => {
      const client = clientReading(method);

      const next = await recoverStepUp(
        client,
        USER_ID,
        { code: "VERIFICATION_REQUIRED" },
        method,
      );

      expect(next).toStrictEqual({
        kind: "ask",
        method,
        error: CURRENT_SECRET_UNAVAILABLE_MESSAGE,
      });
      expect(client.getVerifyMethod).toHaveBeenCalledTimes(1);
    },
  );

  it("returns null for a code it does not own", async () => {
    const next = await recoverStepUp(
      clientReading(),
      USER_ID,
      { code: "OWNER_CANNOT_DELETE" },
      "pin",
    );

    expect(next).toBeNull();
  });
});
