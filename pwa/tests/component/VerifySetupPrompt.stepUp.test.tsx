import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { screen, fireEvent } from "@testing-library/react";
import { currentSecretPrompt } from "moo-family-bookshelf-shared/verifyInput/messages";
import {
  PROMPT_USER_ID,
  clickAndSettle,
  createPromptClient,
  enterPin,
  renderPromptSettled,
  setUpPin,
} from "./helpers/verifySetupPrompt";
import { expectSecretNotStored } from "../helpers/secretStorage";
import { drawPattern, stubPatternGridRect } from "./helpers/patternGrid";

/**
 * VerifySetupPrompt on a `prompted: 0` account (#396): which first step the overlay shows, and what a
 * save sends from each one. Error recovery lives in VerifySetupPrompt.stepUpErrors.test.tsx.
 *
 * Entry decision: the prompt reads `getVerifyPrompted` and `getVerifyMethod` in parallel. A PIN or
 * pattern account opens on 「你已設定登入驗證（PIN 碼／圖形），要改成別的嗎？」 — the server now refuses
 * any change without the current secret, so the old choose screen would only lead to a 403. A
 * `none` / `code` account, and an account whose method read failed (treated as `none`; the server
 * still asks for the secret if it must), keep the old choose flow and send no `currentSecret`.
 *
 * Step-up save: after 「改」 the user enters the current secret, then picks and sets up the new
 * method. Every save's PUT carries `prompted: 1` (#399); a PIN / pattern account's save also carries
 * `currentSecret` (#396). Only 「保持現狀」 / 「之後再說」 call `markVerifyPrompted`, and send nothing
 * else. The secrets live in component state only — no Web Storage entry may hold them after the
 * save (`expectSecretNotStored`).
 */

const CURRENT_PIN = "135791";
const NEW_PIN = "246802";
const KEEP_OR_CHANGE = "你已設定登入驗證（PIN 碼／圖形），要改成別的嗎？";

describe("VerifySetupPrompt step-up entry", () => {
  const onComplete = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it.each(["pin", "pattern"] as const)(
    "opens a prompted:0 %s account on the keep-or-change step",
    async (method) => {
      const client = createPromptClient(method);

      await renderPromptSettled(client, onComplete);

      expect(screen.getByText(KEEP_OR_CHANGE)).toBeInTheDocument();
      expect(screen.queryByText("設定登入驗證")).not.toBeInTheDocument();
      expect(client.getVerifyMethod).toHaveBeenCalledWith(PROMPT_USER_ID);
    },
  );

  it("marks the prompt shown and closes on 保持現狀, without saving a method", async () => {
    const client = createPromptClient("pin");
    await renderPromptSettled(client, onComplete);

    await clickAndSettle(screen.getByRole("button", { name: "保持現狀" }));

    expect(client.markVerifyPrompted).toHaveBeenCalledWith(PROMPT_USER_ID);
    expect(client.setVerifyMethod).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("returns to keep-or-change when the current-secret entry is cancelled", async () => {
    const client = createPromptClient("pin");
    await renderPromptSettled(client, onComplete);

    fireEvent.click(screen.getByRole("button", { name: "改" }));
    expect(
      screen.getByText(currentSecretPrompt("pin", "change")),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByText(KEEP_OR_CHANGE)).toBeInTheDocument();
    expect(client.setVerifyMethod).not.toHaveBeenCalled();
  });

  it("sends the current PIN and prompted:1 with the new PIN, and never marks separately", async () => {
    const client = createPromptClient("pin");
    await renderPromptSettled(client, onComplete);

    fireEvent.click(screen.getByRole("button", { name: "改" }));
    await enterPin(CURRENT_PIN);
    expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    fireEvent.click(screen.getByText("PIN 碼"));
    await setUpPin(NEW_PIN);

    expect(client.setVerifyMethod).toHaveBeenCalledTimes(1);
    expect(client.setVerifyMethod).toHaveBeenCalledWith(PROMPT_USER_ID, {
      method: "pin",
      secret: NEW_PIN,
      currentSecret: CURRENT_PIN,
      prompted: 1,
    });
    expect(client.markVerifyPrompted).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expectSecretNotStored(CURRENT_PIN);
    expectSecretNotStored(NEW_PIN);
  });

  describe("pattern account", () => {
    let restoreRect: () => void = () => {};

    afterEach(() => restoreRect());

    it("asks for the current pattern and sends it serialized with the new method", async () => {
      restoreRect = stubPatternGridRect();
      const client = createPromptClient("pattern");
      await renderPromptSettled(client, onComplete);

      fireEvent.click(screen.getByRole("button", { name: "改" }));
      expect(
        screen.getByText(currentSecretPrompt("pattern", "change")),
      ).toBeInTheDocument();
      drawPattern([0, 1, 2, 5]);
      fireEvent.click(screen.getByRole("button", { name: "確認" }));
      await clickAndSettle(screen.getByText("隨機驗證碼"));

      expect(client.setVerifyMethod).toHaveBeenCalledWith(PROMPT_USER_ID, {
        method: "code",
        currentSecret: "0,1,2,5",
        prompted: 1,
      });
      expect(client.markVerifyPrompted).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledTimes(1);
      expectSecretNotStored("0,1,2,5");
    });
  });

  // A failed read counts as "none": the old flow, no current secret.
  it.each([
    { name: "a none account", read: { data: { method: "none" } } },
    { name: "a code account", read: { data: { method: "code" } } },
    {
      name: "a method read error envelope",
      read: { error: { code: "SERVER_ERROR", message: "x" } },
    },
  ])("keeps the old choose flow for $name", async ({ read }) => {
    const client = createPromptClient("none", {
      getVerifyMethod: vi.fn().mockResolvedValue(read),
    });
    await renderPromptSettled(client, onComplete);

    expect(screen.queryByText(KEEP_OR_CHANGE)).not.toBeInTheDocument();
    await clickAndSettle(screen.getByText("隨機驗證碼"));

    expect(client.setVerifyMethod).toHaveBeenCalledWith(PROMPT_USER_ID, {
      method: "code",
      prompted: 1,
    });
    expect(client.markVerifyPrompted).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps the old choose flow when the method read rejects", async () => {
    const client = createPromptClient("none", {
      getVerifyMethod: vi.fn().mockRejectedValue(new Error("network")),
    });
    await renderPromptSettled(client, onComplete);

    expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
    fireEvent.click(screen.getByText("PIN 碼"));
    await setUpPin(NEW_PIN);

    expect(client.setVerifyMethod).toHaveBeenCalledWith(PROMPT_USER_ID, {
      method: "pin",
      secret: NEW_PIN,
      prompted: 1,
    });
    expect(client.markVerifyPrompted).not.toHaveBeenCalled();
  });
});
