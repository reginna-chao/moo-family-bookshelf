import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { screen, fireEvent } from "@testing-library/react";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import { buildRetryMessage } from "@/utils/retryMessage";
import {
  PROMPT_USER_ID,
  clickAndSettle,
  createPromptClient,
  enterPin,
  renderPromptSettled,
} from "./helpers/verifySetupPrompt";
import { expectSecretNotStored } from "../helpers/secretStorage";

/**
 * VerifySetupPrompt: what a refused save does on the step-up path (#396).
 *
 * `VERIFICATION_FAILED` (wrong current secret) returns to the current-secret entry with the local
 * wrong-secret copy — never the server's message. `VERIFICATION_REQUIRED` (the client's method read
 * was stale or failed) re-reads the method once: a PIN / pattern answer opens the current-secret
 * entry with no error; any other answer, or a failed read, stays put and shows
 * `CURRENT_SECRET_UNAVAILABLE_MESSAGE`. A 429 shows the back-off copy, and any refusal of a save that
 * carried a current secret sends the user back to enter it again — the sent one is spent and
 * cleared from state, which the second PUT's body proves.
 */

const WRONG_PIN = "111111";
const RIGHT_PIN = "222222";

function refusal(code: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message: "server text", ...extra } };
}

/** 改 → enter `pin` as the current secret → choose 隨機驗證碼, the save that needs no new secret. */
async function changeToCodeWith(pin: string) {
  if (screen.queryByRole("button", { name: "改" })) {
    fireEvent.click(screen.getByRole("button", { name: "改" }));
  }
  await enterPin(pin);
  await clickAndSettle(screen.getByText("隨機驗證碼"));
}

function expectOnCurrentSecretEntry() {
  expect(
    screen.getByText(currentSecretPrompt("pin", "change")),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("PIN 輸入")).toHaveValue("");
}

describe("VerifySetupPrompt step-up errors", () => {
  const onComplete = vi.fn();

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("returns to the secret entry with the wrong-PIN copy, then resends only the new secret", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce(refusal("VERIFICATION_FAILED"))
      .mockResolvedValueOnce({ data: { method: "code" } });
    const client = createPromptClient("pin", { setVerifyMethod });
    await renderPromptSettled(client, onComplete);

    await changeToCodeWith(WRONG_PIN);

    expectOnCurrentSecretEntry();
    expect(
      screen.getAllByText(CURRENT_PIN_WRONG_MESSAGE).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText(CURRENT_PATTERN_WRONG_MESSAGE),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    await changeToCodeWith(RIGHT_PIN);

    expect(setVerifyMethod).toHaveBeenLastCalledWith(PROMPT_USER_ID, {
      method: "code",
      currentSecret: RIGHT_PIN,
      prompted: 1,
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expectSecretNotStored(WRONG_PIN);
    expectSecretNotStored(RIGHT_PIN);
  });

  it("opens the secret entry without an error when VERIFICATION_REQUIRED re-reads a PIN", async () => {
    const getVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce({ data: { method: "none" } })
      .mockResolvedValueOnce({ data: { method: "pin" } });
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce(refusal("VERIFICATION_REQUIRED"))
      .mockResolvedValueOnce({ data: { method: "code" } });
    const client = createPromptClient("none", {
      getVerifyMethod,
      setVerifyMethod,
    });
    await renderPromptSettled(client, onComplete);

    await clickAndSettle(screen.getByText("隨機驗證碼"));

    expect(getVerifyMethod).toHaveBeenCalledTimes(2);
    expectOnCurrentSecretEntry();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await changeToCodeWith(RIGHT_PIN);

    expect(setVerifyMethod).toHaveBeenLastCalledWith(PROMPT_USER_ID, {
      method: "code",
      currentSecret: RIGHT_PIN,
      prompted: 1,
    });
    expect(client.markVerifyPrompted).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "a none answer",
      reread: () => Promise.resolve({ data: { method: "none" } }),
    },
    {
      name: "a failed read",
      reread: () => Promise.reject(new Error("network")),
    },
  ])(
    "stays on the choose step with the unavailable copy after $name",
    async ({ reread }) => {
      const getVerifyMethod = vi
        .fn()
        .mockResolvedValueOnce({ data: { method: "none" } })
        .mockImplementationOnce(reread);
      const client = createPromptClient("none", {
        getVerifyMethod,
        setVerifyMethod: vi
          .fn()
          .mockResolvedValue(refusal("VERIFICATION_REQUIRED")),
      });
      await renderPromptSettled(client, onComplete);

      await clickAndSettle(screen.getByText("隨機驗證碼"));

      expect(screen.getByRole("alert")).toHaveTextContent(
        CURRENT_SECRET_UNAVAILABLE_MESSAGE,
      );
      expect(screen.queryByText("server text")).not.toBeInTheDocument();
      expect(screen.getByText("設定登入驗證")).toBeInTheDocument();
      expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "VERIFICATION_LOCKED",
      res: refusal("VERIFICATION_LOCKED", { retryAfter: 90 }),
      copy: buildRetryMessage("VERIFICATION_LOCKED", 90),
    },
    {
      name: "VERIFICATION_LOCKED without a usable wait",
      res: refusal("VERIFICATION_LOCKED", { retryAfter: "soon" }),
      copy: buildRetryMessage("VERIFICATION_LOCKED", 0),
    },
    {
      name: "RATE_LIMITED",
      res: refusal("RATE_LIMITED", { retryAfter: 30 }),
      copy: buildRetryMessage("RATE_LIMITED", 30),
    },
    {
      name: "another server error",
      res: refusal("SERVER_ERROR"),
      copy: "server text",
    },
  ])(
    "shows the copy for $name and asks for the spent secret again",
    async ({ res, copy }) => {
      const client = createPromptClient("pin", {
        setVerifyMethod: vi.fn().mockResolvedValue(res),
      });
      await renderPromptSettled(client, onComplete);

      await changeToCodeWith(WRONG_PIN);

      expect(screen.getAllByText(copy).length).toBeGreaterThan(0);
      expectOnCurrentSecretEntry();
      expect(onComplete).not.toHaveBeenCalled();
    },
  );
});
