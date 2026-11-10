import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import type { VerifyMethod } from "@/api/types";
import { MemberTransferConfirm } from "@/dialog/MemberTransferConfirm";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * MemberTransferConfirm — MemberList's 轉移管理權 confirm. Without a custom family endpoint it shows
 * one 確定; with one, the keep / clear choice. Pressing either reads the verify method: a PIN /
 * pattern account then sees the current-secret entry (`purpose="transfer"`) with its own 確認 and a
 * 取消, and the transfer goes out with the secret and the endpoint choice made before the step. A
 * wrong secret keeps the entry with the method's wrong-secret copy; a `VERIFICATION_REQUIRED` the
 * account can no longer answer returns to the confirm screen with a notice. The list-level outcomes
 * (refresh, error at the foot, the confirm closing) are in MemberList.test.tsx.
 *
 * Focus: the entry shown again after a wrong secret is a new frame (the old one, which had focus, is
 * gone), so it takes focus; the first display does not. The jsdom stub hands the host's `autoFocus`
 * to the inline view (`tests/helpers/secureFrameStub.tsx`), so `document.activeElement` is the truth.
 */

const PIN_PROMPT = "轉移管理權前，請先輸入目前的 PIN 碼。";
const PATTERN_PROMPT = "轉移管理權前，請先畫出目前的圖形。";
const PLAIN_CONFIRM_TEXT =
  "確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。";
const ENDPOINT = "https://my-worker.example.com";

type TransferRes = Awaited<ReturnType<ApiClient["transferOwnership"]>>;
const OK = { data: { familyId: "fam-1" } } as TransferRes;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderConfirm(
  methods: VerifyMethod[],
  responses: Array<TransferRes | Promise<TransferRes>>,
  familyEndpoint?: string,
) {
  const getVerifyMethod = vi.fn(async () => ({
    data: { method: methods.shift() ?? "none" },
  }));
  const transferOwnership = vi.fn(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected transfer");
    return next;
  });
  const callbacks = {
    onStart: vi.fn(),
    onTransferred: vi.fn(),
    onFailed: vi.fn(),
    onCancel: vi.fn(),
  };
  const apiClient = {
    getVerifyMethod,
    transferOwnership,
    getEndpoint: () => "https://family.example",
  } as unknown as ApiClient;
  render(
    <MemberTransferConfirm
      familyId="fam-1"
      userId="user-1"
      targetId="user-2"
      familyEndpoint={familyEndpoint}
      apiClient={apiClient}
      {...callbacks}
    />,
  );
  return { getVerifyMethod, transferOwnership, ...callbacks };
}

/** Click a button by its name; `act` flushes the async work it starts. */
async function click(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function submitPin(pin: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
    target: { value: pin },
  });
  await click("確認");
}

describe("MemberTransferConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transfers a none account at once from the plain confirm", async () => {
    const { transferOwnership, onStart, onTransferred, onFailed } =
      renderConfirm(["none"], [OK]);

    expect(screen.getByText(PLAIN_CONFIRM_TEXT)).toBeInTheDocument();
    await click("確定");

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      undefined,
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
  });

  it("asks a PIN account for its current PIN instead of transferring", async () => {
    const { getVerifyMethod, transferOwnership } = renderConfirm(["pin"], []);

    await click("確定");

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText(PIN_PROMPT)).toBeInTheDocument();
    expect(currentSecretPrompt("pin", "transfer")).toBe(PIN_PROMPT);
    expect(screen.getByLabelText("PIN 碼輸入")).toBeInTheDocument();
    expect(screen.queryByText(PLAIN_CONFIRM_TEXT)).toBeNull();
    expect(screen.queryByRole("button", { name: "確定" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(transferOwnership).not.toHaveBeenCalled();
  });

  it("transfers with the entered PIN", async () => {
    const { transferOwnership, onTransferred } = renderConfirm(["pin"], [OK]);

    await click("確定");
    await submitPin("482913");

    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      "482913",
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("keeps the PIN entry with the wrong-PIN copy, then transfers on the right PIN", async () => {
    const { transferOwnership, onTransferred, onFailed } = renderConfirm(
      ["pin"],
      [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }, OK],
    );

    await click("確定");
    await submitPin("000000");

    expect(screen.getByText(PIN_PROMPT)).toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    // The refused PIN is not left in the entry: it remounts empty.
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveValue("");
    expect(screen.queryByText("server text")).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();

    await submitPin("482913");
    expect(transferOwnership).toHaveBeenLastCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      "482913",
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const { transferOwnership } = renderConfirm(
      ["pattern"],
      [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }],
    );

    await click("確定");
    expect(screen.getByText(PATTERN_PROMPT)).toBeInTheDocument();
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(transferOwnership).toHaveBeenCalledWith(
      "fam-1",
      "user-1",
      "user-2",
      undefined,
      "0,3,6,7",
    );
    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
  });

  it.each<[string, 1 | undefined]>([
    ["清除並轉移", 1],
    ["不清除，直接轉移", undefined],
  ])(
    "sends the custom-endpoint choice %s with the PIN entered after it",
    async (button, clearEndpoint) => {
      const { transferOwnership } = renderConfirm(["pin"], [OK], ENDPOINT);

      expect(screen.getByText(ENDPOINT)).toBeInTheDocument();
      await click(button);
      expect(screen.queryByText(ENDPOINT)).toBeNull();
      await submitPin("482913");

      expect(transferOwnership).toHaveBeenCalledTimes(1);
      expect(transferOwnership).toHaveBeenCalledWith(
        "fam-1",
        "user-1",
        "user-2",
        clearEndpoint,
        "482913",
      );
    },
  );

  it("marks only the pressed endpoint choice as busy while a none account transfers", async () => {
    const pending = deferred<TransferRes>();
    const { onTransferred } = renderConfirm(
      ["none"],
      [pending.promise],
      ENDPOINT,
    );

    await click("清除並轉移");

    expect(screen.getByRole("button", { name: "處理中..." })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "不清除，直接轉移" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    await act(async () => {
      pending.resolve(OK);
    });
    expect(onTransferred).toHaveBeenCalledTimes(1);
  });

  it("disables the secret step's 取消 while the PIN is being checked", async () => {
    const pending = deferred<TransferRes>();
    renderConfirm(["pin"], [pending.promise]);

    await click("確定");
    await submitPin("482913");

    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => {
      pending.resolve(OK);
    });
  });

  it("returns to the confirm screen with the notice when the account no longer has a secret", async () => {
    const { onFailed, onTransferred } = renderConfirm(
      ["pin", "none"],
      [{ error: { code: "VERIFICATION_REQUIRED", message: "server text" } }],
    );

    await click("確定");
    await submitPin("482913");

    expect(screen.getByText(PLAIN_CONFIRM_TEXT)).toBeInTheDocument();
    expect(
      screen.getByText(CURRENT_SECRET_UNAVAILABLE_MESSAGE),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
    expect(screen.queryByText("server text")).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it("hands a refusal's copy to onFailed", async () => {
    const { onFailed, onTransferred } = renderConfirm(
      ["none"],
      [{ error: { code: "FORBIDDEN", message: "權限不足" } }],
    );

    await click("確定");

    expect(onFailed).toHaveBeenCalledWith("權限不足");
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it("cancels from the secret step without sending anything", async () => {
    const { transferOwnership, onCancel } = renderConfirm(["pin"], []);

    await click("確定");
    await click("取消");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(transferOwnership).not.toHaveBeenCalled();
    // The component stays mounted here (MemberList unmounts it); its own state is reset.
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
  });

  it("does not focus the PIN entry on its first display", async () => {
    renderConfirm(["pin"], []);

    await click("確定");

    expect(screen.getByLabelText("PIN 碼輸入")).not.toBe(
      document.activeElement,
    );
  });

  it("focuses the PIN entry shown again after a wrong PIN", async () => {
    renderConfirm(
      ["pin"],
      [{ error: { code: "VERIFICATION_FAILED", message: "server text" } }],
    );

    await click("確定");
    const first = screen.getByLabelText("PIN 碼輸入");
    await submitPin("000000");

    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    // The entry was remounted, so the frame that had focus is gone.
    expect(first.isConnected).toBe(false);
    expect(screen.getByLabelText("PIN 碼輸入")).toBe(document.activeElement);
  });
});
