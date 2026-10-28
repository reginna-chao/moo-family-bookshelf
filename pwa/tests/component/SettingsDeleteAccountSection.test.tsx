import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CURRENT_PIN_WRONG_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import { SettingsDeleteAccountSection } from "@/components/SettingsDeleteAccountSection";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/utils/selfDeparture";
import { expectSecretNotStored } from "../helpers/secretStorage";
import { stubPatternGridRect } from "./helpers/patternGrid";

/**
 * SettingsDeleteAccountSection — 「移除帳戶」 on a PIN / pattern account (#396). The confirm card puts
 * the current-secret entry between the warning and the buttons; the entry's own 確認 submits the
 * delete, so the plain 確定移除 is hidden while 取消 stays. A wrong secret keeps the card open with the
 * wrong-secret copy. An account with no secret (`none` / `code`), or one whose method read failed,
 * keeps the old card: 確定移除, no entry, no body sent. Hook-level outcomes:
 * pwa/tests/unit/hooks/useDeleteAccount.stepUp.test.ts.
 */

const USER_ID = "b".repeat(64);
const SECRET = "864200";

function renderSection(
  read: () => Promise<unknown>,
  deleteRes: unknown = { data: { ok: true } },
) {
  const apiClient = {
    getVerifyMethod: vi.fn(read),
    deleteAccount: vi.fn().mockResolvedValue(deleteRes),
  };
  const onForceLogout = vi.fn();
  render(
    <SettingsDeleteAccountSection
      userId={USER_ID}
      apiClient={apiClient as unknown as ApiClient}
      onForceLogout={onForceLogout}
    />,
  );
  return { apiClient, onForceLogout };
}

const answers = (method: string) => () => Promise.resolve({ data: { method } });

async function settledClick(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openConfirm() {
  await settledClick(screen.getByRole("button", { name: "移除帳戶" }));
  expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
}

describe("SettingsDeleteAccountSection step-up", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it("asks a PIN account for its current PIN in place of 確定移除, and deletes with it", async () => {
    const { apiClient, onForceLogout } = renderSection(answers("pin"));
    await openConfirm();

    expect(
      screen.getByText(currentSecretPrompt("pin", "delete")),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "確定移除" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("PIN 輸入"), {
      target: { value: SECRET },
    });
    await settledClick(screen.getByRole("button", { name: "確認" }));

    expect(apiClient.deleteAccount).toHaveBeenCalledWith(USER_ID, SECRET);
    expect(onForceLogout).toHaveBeenCalledTimes(1);
    expectSecretNotStored(SECRET);
  });

  it("keeps the card open with the wrong-PIN copy after VERIFICATION_FAILED", async () => {
    const { onForceLogout } = renderSection(answers("pin"), {
      error: { code: "VERIFICATION_FAILED", message: "server text" },
    });
    await openConfirm();

    fireEvent.change(screen.getByLabelText("PIN 輸入"), {
      target: { value: SECRET },
    });
    await settledClick(screen.getByRole("button", { name: "確認" }));

    expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      CURRENT_PIN_WRONG_MESSAGE,
    );
    expect(screen.getByLabelText("PIN 輸入")).toBeInTheDocument();
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(onForceLogout).not.toHaveBeenCalled();
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const restoreRect = stubPatternGridRect();
    try {
      renderSection(answers("pattern"));
      await openConfirm();

      expect(
        screen.getByText(currentSecretPrompt("pattern", "delete")),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("圖形鎖定")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "確定移除" }),
      ).not.toBeInTheDocument();
    } finally {
      restoreRect();
    }
  });

  it.each([
    { name: "a none account", read: answers("none") },
    { name: "a code account", read: answers("code") },
    {
      name: "a failed method read",
      read: () => Promise.reject(new Error("network")),
    },
  ])(
    "keeps the plain 確定移除 and sends no secret for $name",
    async ({ read }) => {
      const { apiClient, onForceLogout } = renderSection(read);
      await openConfirm();

      expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("圖形鎖定")).not.toBeInTheDocument();
      await settledClick(screen.getByRole("button", { name: "確定移除" }));

      expect(apiClient.getVerifyMethod).toHaveBeenCalledWith(USER_ID);
      expect(apiClient.deleteAccount).toHaveBeenCalledWith(USER_ID, undefined);
      expect(onForceLogout).toHaveBeenCalledTimes(1);
    },
  );
});
