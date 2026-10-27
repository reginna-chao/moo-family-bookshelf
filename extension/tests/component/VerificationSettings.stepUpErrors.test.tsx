import { act, fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";
import {
  pickMethod,
  putBody,
  renderVerifySettings,
  submitPin,
} from "./helpers/verifySettingsStepUp";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * VerificationSettings step-up errors (#396). `VERIFICATION_FAILED` on a save that carried the current
 * secret returns to the secret step with an empty entry and the method's wrong-secret copy — never the
 * server's text. `VERIFICATION_REQUIRED` (the panel read the method as `none` / `code` but the server
 * holds a PIN) re-reads the method once: PIN / pattern ⇒ the secret step without an error, then the
 * retried save carries the secret; anything else ⇒ `CURRENT_SECRET_UNAVAILABLE_MESSAGE` and no entry.
 * The two 429 codes show the Extension's back-off copy on the secret step. The 「server text」 message
 * every refusal carries must never reach the screen.
 */

const CURRENT = "111111";
const PROMPT = "要更改登入驗證，請先輸入目前的 PIN 碼。";

function refusal(code: string, retryAfter?: number) {
  return { error: { code, message: "server text", retryAfter } };
}

describe("VerificationSettings step-up errors", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("returns to an empty PIN step with the wrong-PIN copy, then retries with the new entry", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce(refusal("VERIFICATION_FAILED"))
      .mockResolvedValue({ data: { ok: true } });
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod("隨機驗證碼");
    await submitPin(CURRENT);

    expect(putBody(setVerifyMethod)).toStrictEqual({
      method: "code",
      currentSecret: CURRENT,
    });
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveValue("");
    expect(screen.queryByText("server text")).not.toBeInTheDocument();

    await submitPin("123456");
    expect(putBody(setVerifyMethod, 1)).toStrictEqual({
      method: "code",
      currentSecret: "123456",
    });
    expect(screen.getByText("已儲存")).toBeInTheDocument();
  });

  it("returns to the PIN step when the setup save is refused", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_FAILED"));
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod("PIN 碼");
    await submitPin(CURRENT);
    await submitPin("222222");
    await submitPin("222222");

    expect(putBody(setVerifyMethod)).toStrictEqual({
      method: "pin",
      secret: "222222",
      currentSecret: CURRENT,
    });
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.queryByText("設定 PIN 碼")).not.toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
  });

  it("shows the wrong-pattern copy on a pattern account", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_FAILED"));
    await renderVerifySettings(["pattern"], setVerifyMethod);

    await pickMethod("隨機驗證碼");
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(putBody(setVerifyMethod)).toStrictEqual({
      method: "code",
      currentSecret: "0,3,6,7",
    });
    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(
      screen.queryByText(CURRENT_PIN_WRONG_MESSAGE),
    ).not.toBeInTheDocument();
  });

  it("switches to the PIN step when the server requires a secret the panel did not know of", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce(refusal("VERIFICATION_REQUIRED"))
      .mockResolvedValue({ data: { ok: true } });
    const { getVerifyMethod } = await renderVerifySettings(
      ["none", "pin"],
      setVerifyMethod,
    );

    await pickMethod("隨機驗證碼");

    expect(putBody(setVerifyMethod)).toStrictEqual({ method: "code" });
    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByText("目前方式：PIN 碼")).toBeInTheDocument();
    expect(
      screen.queryByText(CURRENT_PIN_WRONG_MESSAGE),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("server text")).not.toBeInTheDocument();

    await submitPin(CURRENT);
    expect(putBody(setVerifyMethod, 1)).toStrictEqual({
      method: "code",
      currentSecret: CURRENT,
    });
  });

  it("stays put with the unavailable copy when the re-read is not PIN / pattern", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_REQUIRED"));
    const { getVerifyMethod } = await renderVerifySettings(
      ["none", "none"],
      setVerifyMethod,
    );

    await pickMethod("隨機驗證碼");

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText(CURRENT_SECRET_UNAVAILABLE_MESSAGE),
    ).toBeInTheDocument();
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
  });

  it.each([
    ["VERIFICATION_LOCKED", 900, verificationLockedMessage(900)],
    ["RATE_LIMITED", 60, rateLimitedMessage(60)],
  ])(
    "shows the back-off copy on the PIN step for %s",
    async (code, retryAfter, expected) => {
      const setVerifyMethod = vi
        .fn()
        .mockResolvedValue(refusal(code, retryAfter));
      await renderVerifySettings(["pin"], setVerifyMethod);

      await pickMethod("隨機驗證碼");
      await submitPin(CURRENT);

      expect(screen.getByText(expected)).toBeInTheDocument();
      expect(screen.getByText(PROMPT)).toBeInTheDocument();
      expect(screen.queryByText("server text")).not.toBeInTheDocument();
    },
  );
});
