import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CURRENT_PIN_WRONG_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import { MemberTransferConfirm } from "@/components/MemberTransferConfirm";
import { expectSecretNotStored } from "../helpers/secretStorage";
import { stubPatternGridRect } from "./helpers/patternGrid";

/**
 * MemberTransferConfirm — MemberList's in-row 轉移管理權 confirm (PWA). 確定 starts the flow: an account
 * with no secret (`none` / `code`, or a failed method read) transfers at once with no secret; a PIN /
 * pattern account swaps the confirm for the current-secret entry (`purpose="transfer"`), whose own
 * 確認 sends the secret. A wrong secret keeps the entry with the wrong-secret copy; any other failure
 * goes to `onFailed` and the confirm question returns. 取消 on either screen calls `onCancel`.
 * Hook-level outcomes: pwa/tests/unit/hooks/useTransferOwnership.test.ts.
 */

const FAMILY_ID = "fam-1";
const USER_ID = "a".repeat(64);
const TARGET_ID = "b".repeat(64);
const SECRET = "864200";
const QUESTION = "確定要將管理權轉移給 小明？轉移後你將無法移除其他成員。";

function renderConfirm(
  read: () => Promise<unknown>,
  transfer: () => Promise<unknown> = () =>
    Promise.resolve({ data: { ok: true } }),
) {
  const apiClient = {
    getVerifyMethod: vi.fn(read),
    transferOwnership: vi.fn(transfer),
  };
  const callbacks = {
    onStart: vi.fn(),
    onTransferred: vi.fn(),
    onFailed: vi.fn(),
    onCancel: vi.fn(),
  };
  render(
    <MemberTransferConfirm
      familyId={FAMILY_ID}
      userId={USER_ID}
      targetId={TARGET_ID}
      label="小明"
      apiClient={apiClient as unknown as ApiClient}
      {...callbacks}
    />,
  );
  return { apiClient, ...callbacks };
}

const answers = (method: string) => () => Promise.resolve({ data: { method } });

async function settledClick(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function confirm() {
  await settledClick(screen.getByRole("button", { name: "確定" }));
}

async function enterPin(secret = SECRET) {
  fireEvent.change(screen.getByLabelText("PIN 輸入"), {
    target: { value: secret },
  });
  await settledClick(screen.getByRole("button", { name: "確認" }));
}

describe("MemberTransferConfirm", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("asks the transfer question with the member's label, and nothing is read yet", () => {
    const { apiClient } = renderConfirm(answers("none"));

    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
    expect(apiClient.getVerifyMethod).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a none account", read: answers("none") },
    { name: "a code account", read: answers("code") },
    {
      name: "a failed method read",
      read: () => Promise.reject(new Error("network")),
    },
  ])("transfers at once with no secret for $name", async ({ read }) => {
    const { apiClient, onStart, onTransferred, onFailed } = renderConfirm(read);

    await confirm();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(apiClient.getVerifyMethod).toHaveBeenCalledWith(USER_ID);
    expect(apiClient.transferOwnership).toHaveBeenCalledWith(
      FAMILY_ID,
      USER_ID,
      TARGET_ID,
      undefined,
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
  });

  it("asks a PIN account for its current PIN in place of the question, and transfers with it", async () => {
    const { apiClient, onTransferred, onFailed } = renderConfirm(
      answers("pin"),
    );

    await confirm();

    // Literal pinned at the render site; the builder is shared with the Extension.
    expect(
      screen.getByText("轉移管理權前，請先輸入目前的 PIN 碼。"),
    ).toBeInTheDocument();
    expect(currentSecretPrompt("pin", "transfer")).toBe(
      "轉移管理權前，請先輸入目前的 PIN 碼。",
    );
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "確定" }),
    ).not.toBeInTheDocument();
    expect(apiClient.transferOwnership).not.toHaveBeenCalled();

    await enterPin();

    expect(apiClient.transferOwnership).toHaveBeenCalledTimes(1);
    expect(apiClient.transferOwnership).toHaveBeenCalledWith(
      FAMILY_ID,
      USER_ID,
      TARGET_ID,
      SECRET,
    );
    expect(onTransferred).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    expectSecretNotStored(SECRET);
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const restoreRect = stubPatternGridRect();
    try {
      const { apiClient } = renderConfirm(answers("pattern"));

      await confirm();

      expect(
        screen.getByText("轉移管理權前，請先畫出目前的圖形。"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("圖形鎖定")).toBeInTheDocument();
      expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
      expect(apiClient.transferOwnership).not.toHaveBeenCalled();
    } finally {
      restoreRect();
    }
  });

  it("keeps the PIN entry with the wrong-PIN copy after VERIFICATION_FAILED", async () => {
    const { onFailed, onTransferred } = renderConfirm(answers("pin"), () =>
      Promise.resolve({
        error: { code: "VERIFICATION_FAILED", message: "server text" },
      }),
    );
    await confirm();

    await enterPin();

    // The refused PIN is not left in the entry: it remounts empty.
    expect(screen.getByLabelText("PIN 輸入")).toHaveValue("");
    expect(screen.getByRole("alert")).toHaveTextContent(
      CURRENT_PIN_WRONG_MESSAGE,
    );
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onTransferred).not.toHaveBeenCalled();
  });

  it("hands any other failure to onFailed and brings the question back", async () => {
    const { onFailed, onTransferred } = renderConfirm(answers("pin"), () =>
      Promise.resolve({ error: { code: "NOT_OWNER", message: "不是管理者" } }),
    );
    await confirm();

    await enterPin();

    expect(onFailed).toHaveBeenCalledWith("不是管理者");
    expect(onTransferred).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
  });

  it("disables both buttons and shows 處理中... while the transfer is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    renderConfirm(
      answers("none"),
      () => new Promise((resolve) => (release = resolve)),
    );

    await confirm();

    expect(screen.getByRole("button", { name: "處理中..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();

    await act(async () => {
      release({ data: { ok: true } });
    });
    expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
  });

  it("disables the PIN entry while the secret is being sent", async () => {
    let release: (v: unknown) => void = () => {};
    renderConfirm(
      answers("pin"),
      () => new Promise((resolve) => (release = resolve)),
    );
    await confirm();

    await enterPin();

    expect(screen.getByLabelText("PIN 輸入")).toBeDisabled();
    await act(async () => {
      release({ data: { ok: true } });
    });
  });

  it("calls onCancel from the confirm question", async () => {
    const { onCancel, apiClient } = renderConfirm(answers("none"));

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiClient.transferOwnership).not.toHaveBeenCalled();
  });

  it("calls onCancel from the secret entry without sending anything", async () => {
    const { onCancel, apiClient } = renderConfirm(answers("pin"));
    await confirm();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(apiClient.transferOwnership).not.toHaveBeenCalled();
  });
});
