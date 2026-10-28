import { describe, it, expect, vi } from "vitest";
import { requiresCurrentSecret } from "moo-family-bookshelf-shared/api/verifyValidation";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";
import {
  readVerifyMethod,
  recoverStepUp,
  stepUpBackoffMessage,
} from "@/dialog/stepUp";
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";

/**
 * stepUp — the shared decisions behind a refused verify change or account deletion (#396), used by
 * `useVerifyMethodFlow` and `useFamilySettingsDelete`. `VERIFICATION_FAILED` asks again for the secret
 * that was sent; `VERIFICATION_REQUIRED` re-reads the method exactly once and asks only when the
 * account now reads as PIN / pattern; the two 429 codes map to the Extension's back-off copy; anything
 * else returns null so the caller keeps its own handling. The server's message is never surfaced.
 */

/** Client whose `getVerifyMethod` resolves `method` (null: an error envelope) or rejects on `throws`. */
function client(method: VerifyMethod | null, throws = false) {
  const getVerifyMethod = vi.fn(async () => {
    if (throws) throw new Error("offline");
    return method === null
      ? { error: { code: "SERVER_ERROR", message: "boom" } }
      : { data: { method } };
  });
  return { api: { getVerifyMethod } as unknown as ApiClient, getVerifyMethod };
}

describe("requiresCurrentSecret", () => {
  it.each<[VerifyMethod, boolean]>([
    ["pin", true],
    ["pattern", true],
    ["code", false],
    ["none", false],
  ])("returns %s → %s", (method, expected) => {
    expect(requiresCurrentSecret(method)).toBe(expected);
  });
});

describe("readVerifyMethod", () => {
  it("returns the method the server reads now", async () => {
    const { api, getVerifyMethod } = client("pattern");
    expect(await readVerifyMethod(api, "user-1")).toBe("pattern");
    expect(getVerifyMethod).toHaveBeenCalledWith("user-1");
  });

  it.each([
    ["an error envelope", client(null).api],
    ["a thrown request", client("pin", true).api],
  ])("returns null for %s", async (_label, api) => {
    expect(await readVerifyMethod(api, "user-1")).toBeNull();
  });
});

describe("stepUpBackoffMessage", () => {
  it.each([
    [
      { code: "VERIFICATION_LOCKED", retryAfter: 90 },
      verificationLockedMessage(90),
    ],
    [
      { code: "VERIFICATION_LOCKED", retryAfter: 90.7 },
      verificationLockedMessage(90),
    ],
    [{ code: "VERIFICATION_LOCKED" }, verificationLockedMessage(null)],
    [
      { code: "VERIFICATION_LOCKED", retryAfter: Number.NaN },
      verificationLockedMessage(null),
    ],
    [
      { code: "VERIFICATION_LOCKED", retryAfter: -1 },
      verificationLockedMessage(null),
    ],
    [{ code: "RATE_LIMITED", retryAfter: 30 }, rateLimitedMessage(30)],
    [{ code: "RATE_LIMITED" }, rateLimitedMessage(null)],
    [{ code: "SERVER_ERROR", retryAfter: 30 }, null],
  ])("maps %o to its back-off copy", (error, expected) => {
    expect(stepUpBackoffMessage(error)).toBe(expected);
  });
});

describe("recoverStepUp", () => {
  it.each<[VerifyMethod, string]>([
    ["pin", CURRENT_PIN_WRONG_MESSAGE],
    ["pattern", CURRENT_PATTERN_WRONG_MESSAGE],
  ])(
    "asks again for the %s that was refused, without re-reading the method",
    async (asked, message) => {
      const { api, getVerifyMethod } = client("none");
      const next = await recoverStepUp(
        api,
        "user-1",
        { code: "VERIFICATION_FAILED" },
        asked,
      );
      expect(next).toEqual({ kind: "ask", method: asked, error: message });
      expect(getVerifyMethod).not.toHaveBeenCalled();
    },
  );

  it.each<[string, VerifyMethod | null]>([
    ["no secret was sent", null],
    ["the sent method has no secret", "code"],
  ])("leaves VERIFICATION_FAILED to the caller when %s", async (_l, asked) => {
    const { api } = client("pin");
    const error = { code: "VERIFICATION_FAILED" };
    expect(await recoverStepUp(api, "user-1", error, asked)).toBeNull();
  });

  it.each<VerifyMethod>(["pin", "pattern"])(
    "switches to the secret step without an error when the re-read says %s",
    async (method) => {
      const { api, getVerifyMethod } = client(method);
      const error = { code: "VERIFICATION_REQUIRED" };
      const next = await recoverStepUp(api, "user-1", error, null);
      expect(next).toEqual({ kind: "ask", method, error: "" });
      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    },
  );

  it.each<VerifyMethod>(["pin", "pattern"])(
    "asks again with the unavailable copy when a sent secret meets VERIFICATION_REQUIRED and the re-read says %s",
    async (method) => {
      const { api, getVerifyMethod } = client(method);
      const error = { code: "VERIFICATION_REQUIRED" };
      const next = await recoverStepUp(api, "user-1", error, method);
      expect(next).toEqual({
        kind: "ask",
        method,
        error: CURRENT_SECRET_UNAVAILABLE_MESSAGE,
      });
      expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["none", client("none")],
    ["code", client("code")],
    ["a failed read", client(null)],
    ["a thrown read", client("pin", true)],
  ])("stays put with the unavailable copy after %s", async (_l, c) => {
    const error = { code: "VERIFICATION_REQUIRED", message: "此帳號需要驗證" };
    const next = await recoverStepUp(c.api, "user-1", error, "pin");
    expect(next).toEqual({
      kind: "message",
      error: CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    });
    expect(c.getVerifyMethod).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { code: "VERIFICATION_LOCKED", retryAfter: 900 },
      verificationLockedMessage(900),
    ],
    [{ code: "RATE_LIMITED", retryAfter: 60 }, rateLimitedMessage(60)],
  ])("shows the back-off copy for %o", async (error, expected) => {
    const { api } = client("pin");
    const next = await recoverStepUp(api, "user-1", error, "pin");
    expect(next).toEqual({ kind: "message", error: expected });
  });

  it("returns null for any other code", async () => {
    const { api, getVerifyMethod } = client("pin");
    const error = { code: "SERVER_ERROR" };
    expect(await recoverStepUp(api, "user-1", error, "pin")).toBeNull();
    expect(getVerifyMethod).not.toHaveBeenCalled();
  });
});
