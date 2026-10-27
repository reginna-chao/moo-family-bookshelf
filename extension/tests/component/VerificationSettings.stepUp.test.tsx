import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { currentSecretPrompt } from "moo-family-bookshelf-shared/verifyInput/messages";
import { AUTH_TOKEN_KEY } from "@/constants";
import {
  pickMethod,
  putBody,
  renderVerifySettings,
  submitPin,
} from "./helpers/verifySettingsStepUp";

/**
 * VerificationSettings step-up (#396): on a PIN / pattern account, picking ANY method first asks for
 * the current secret (`CurrentSecretStep`, `PinInput` / `PatternLock` in verify mode); only then does
 * the old flow run (setup, the none warning, or the immediate 隨機驗證碼 save), and the PUT body
 * carries `currentSecret` beside the new secret. A `none` / `code` account keeps the old flow and its
 * body has no `currentSecret` key. The secret lives only in the flow hook's state: it is never written
 * to `browser.storage.local` (the rotated-token write is the positive companion proving the spy sees
 * this flow's writes), and the entry is empty whenever the step is shown again. Error mapping lives in
 * VerificationSettings.stepUpErrors.test.tsx.
 */

const TOKEN = "0123456789abcdef".repeat(4);
const CURRENT = "111111";
const PROMPT = "要更改登入驗證，請先輸入目前的 PIN 碼。";

/** True when any `browser.storage.local.set` call so far carried `secret`. */
function storageSawSecret(secret: string): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some((call) => JSON.stringify(call[0]).includes(secret));
}

describe("VerificationSettings step-up", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it.each(["PIN 碼", "圖形驗證", "隨機驗證碼", "不設定驗證"])(
    "asks a PIN account for its current PIN before %s",
    async (label) => {
      const setVerifyMethod = vi.fn();
      await renderVerifySettings(["pin"], setVerifyMethod);

      await pickMethod(label);

      // Literal pin of the render site; the helper is pinned in tests/unit/verifyInputRules.test.ts.
      expect(screen.getByText(PROMPT)).toBeInTheDocument();
      expect(currentSecretPrompt("pin", "change")).toBe(PROMPT);
      expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
      expect(screen.queryByText("設定 PIN 碼")).not.toBeInTheDocument();
      expect(screen.queryByText("確定不設定驗證")).not.toBeInTheDocument();
      expect(setVerifyMethod).not.toHaveBeenCalled();
    },
  );

  it("asks a pattern account to draw its current pattern", async () => {
    await renderVerifySettings(["pattern"], vi.fn());

    await pickMethod("PIN 碼");

    expect(
      screen.getByText("要更改登入驗證，請先畫出目前的圖形。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("application")).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

  it("continues to the PIN setup and sends the current and new PIN together", async () => {
    const setVerifyMethod = vi.fn().mockResolvedValue({
      data: { method: "pin", prompted: 1, authToken: TOKEN },
    });
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod("PIN 碼");
    await submitPin(CURRENT);
    expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
    expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
    await submitPin("222222");
    await submitPin("222222");

    expect(setVerifyMethod).toHaveBeenCalledTimes(1);
    expect(putBody(setVerifyMethod)).toEqual({
      method: "pin",
      secret: "222222",
      currentSecret: CURRENT,
    });
    expect(screen.getByText("已儲存")).toBeInTheDocument();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [AUTH_TOKEN_KEY]: TOKEN,
    });
    expect(storageSawSecret(CURRENT)).toBe(false);
  });

  it.each([
    ["隨機驗證碼", { method: "code", currentSecret: CURRENT }],
    ["不設定驗證", { method: "none", currentSecret: CURRENT }],
  ])("sends the current PIN with a %s save", async (label, expectedBody) => {
    const setVerifyMethod = vi.fn().mockResolvedValue({ data: { ok: true } });
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod(label);
    await submitPin(CURRENT);
    if (label === "不設定驗證") await pickMethod("確定不設定驗證");

    expect(putBody(setVerifyMethod)).toEqual(expectedBody);
    expect(screen.getByText("已儲存")).toBeInTheDocument();
    expect(storageSawSecret(CURRENT)).toBe(false);
  });

  it("asks again with an empty entry after a PIN change, and sends only the new entry", async () => {
    const setVerifyMethod = vi.fn().mockResolvedValue({ data: { ok: true } });
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod("PIN 碼");
    await submitPin(CURRENT);
    await submitPin("222222");
    await submitPin("222222");
    expect(screen.getByText("已儲存")).toBeInTheDocument();
    await pickMethod("不設定驗證");

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveValue("");
    await submitPin("222222");
    await pickMethod("確定不設定驗證");

    expect(putBody(setVerifyMethod, 1)).toStrictEqual({
      method: "none",
      currentSecret: "222222",
    });
  });

  it.each<["none" | "code", string]>([
    ["none", "目前方式：不設定驗證"],
    ["code", "目前方式：隨機驗證碼"],
  ])(
    "keeps the old flow on a %s account: no prompt, no currentSecret",
    async (method, label) => {
      const setVerifyMethod = vi.fn().mockResolvedValue({ data: { ok: true } });
      await renderVerifySettings([method], setVerifyMethod);
      expect(screen.getByText(label)).toBeInTheDocument();

      await pickMethod("PIN 碼");
      expect(screen.queryByText(PROMPT)).not.toBeInTheDocument();
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
      await submitPin("222222");
      await submitPin("222222");

      expect(putBody(setVerifyMethod)).toStrictEqual({
        method: "pin",
        secret: "222222",
      });
    },
  );

  it("follows the method picked last when the choice changes during the secret step", async () => {
    await renderVerifySettings(["pin"], vi.fn());

    await pickMethod("PIN 碼");
    await pickMethod("圖形驗證");
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    await submitPin(CURRENT);

    expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
    expect(screen.queryByText("設定 PIN 碼")).not.toBeInTheDocument();
  });
});
