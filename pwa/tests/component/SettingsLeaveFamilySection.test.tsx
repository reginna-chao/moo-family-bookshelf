import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import { SettingsLeaveFamilySection } from "@/components/SettingsLeaveFamilySection";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/utils/selfDeparture";
import { expectSecretNotStored } from "../helpers/secretStorage";
import { stubPatternGridRect } from "./helpers/patternGrid";

/**
 * SettingsLeaveFamilySection — 「離開家庭」 on a PIN / pattern account. Opening the confirm reads the
 * verify method; a PIN / pattern account gets the current-secret entry (`purpose="leave"`) in place of
 * 確定離開, and the entry's own 確認 sends the leave with the secret. A wrong secret keeps the entry
 * with the wrong-secret copy. An account with no secret (`none` / `code`), or one whose method read
 * failed, keeps the old 確定離開 / 取消 pair and sends no secret. 取消 on the entry returns to the
 * 離開家庭 button. Hook-level outcomes: pwa/tests/unit/hooks/useLeaveFamily.test.ts.
 */

const FAMILY_ID = "fam-1";
const USER_ID = "b".repeat(64);
const SECRET = "864200";

function renderSection(
  read: () => Promise<unknown>,
  leaveRes: unknown = { data: { ok: true } },
) {
  const apiClient = {
    getVerifyMethod: vi.fn(read),
    leaveFamily: vi.fn().mockResolvedValue(leaveRes),
  };
  const onLogout = vi.fn();
  render(
    <SettingsLeaveFamilySection
      familyId={FAMILY_ID}
      userId={USER_ID}
      apiClient={apiClient as unknown as ApiClient}
      onLogout={onLogout}
    />,
  );
  return { apiClient, onLogout };
}

const answers = (method: string) => () => Promise.resolve({ data: { method } });

async function settledClick(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openConfirm() {
  await settledClick(screen.getByRole("button", { name: "離開家庭" }));
}

async function enterPin(secret = SECRET) {
  fireEvent.change(screen.getByLabelText("PIN 輸入"), {
    target: { value: secret },
  });
  await settledClick(screen.getByRole("button", { name: "確認" }));
}

describe("SettingsLeaveFamilySection current-secret step", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  it("asks a PIN account for its current PIN in place of 確定離開, and leaves with it", async () => {
    const { apiClient, onLogout } = renderSection(answers("pin"));
    await openConfirm();

    // Literal pinned at the render site; the builder is shared with the Extension.
    expect(
      screen.getByText("離開家庭前，請先輸入目前的 PIN 碼。"),
    ).toBeInTheDocument();
    expect(currentSecretPrompt("pin", "leave")).toBe(
      "離開家庭前，請先輸入目前的 PIN 碼。",
    );
    expect(
      screen.queryByRole("button", { name: "確定離開" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(apiClient.leaveFamily).not.toHaveBeenCalled();

    await enterPin();

    expect(apiClient.leaveFamily).toHaveBeenCalledTimes(1);
    expect(apiClient.leaveFamily).toHaveBeenCalledWith(
      FAMILY_ID,
      USER_ID,
      SECRET,
    );
    expect(onLogout).toHaveBeenCalledTimes(1);
    expectSecretNotStored(SECRET);
  });

  it("keeps the PIN entry open with the wrong-PIN copy after VERIFICATION_FAILED", async () => {
    const { onLogout } = renderSection(answers("pin"), {
      error: { code: "VERIFICATION_FAILED", message: "server text" },
    });
    await openConfirm();

    await enterPin();

    expect(screen.getByLabelText("PIN 輸入")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      CURRENT_PIN_WRONG_MESSAGE,
    );
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "離開家庭" }),
    ).not.toBeInTheDocument();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const restoreRect = stubPatternGridRect();
    try {
      const { apiClient } = renderSection(answers("pattern"));
      await openConfirm();

      expect(
        screen.getByText("離開家庭前，請先畫出目前的圖形。"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("圖形鎖定")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "確定離開" }),
      ).not.toBeInTheDocument();
      expect(apiClient.leaveFamily).not.toHaveBeenCalled();
    } finally {
      restoreRect();
    }
  });

  it("returns to the 離開家庭 button when the PIN entry is cancelled", async () => {
    const { apiClient } = renderSection(answers("pin"));
    await openConfirm();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "離開家庭" }),
    ).toBeInTheDocument();
    expect(apiClient.leaveFamily).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a none account", read: answers("none") },
    { name: "a code account", read: answers("code") },
    {
      name: "a failed method read",
      read: () => Promise.reject(new Error("network")),
    },
  ])(
    "keeps the plain 確定離開 and sends no secret for $name",
    async ({ read }) => {
      const { apiClient, onLogout } = renderSection(read);
      await openConfirm();

      expect(screen.queryByLabelText("PIN 輸入")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("圖形鎖定")).not.toBeInTheDocument();
      await settledClick(screen.getByRole("button", { name: "確定離開" }));

      expect(apiClient.getVerifyMethod).toHaveBeenCalledWith(USER_ID);
      expect(apiClient.leaveFamily).toHaveBeenCalledWith(
        FAMILY_ID,
        USER_ID,
        undefined,
      );
      expect(onLogout).toHaveBeenCalledTimes(1);
    },
  );

  it("asks for the PIN when a none-read account is refused with VERIFICATION_REQUIRED and re-reads a PIN", async () => {
    const getVerifyMethod = vi
      .fn()
      .mockResolvedValueOnce({ data: { method: "none" } })
      .mockResolvedValue({ data: { method: "pin" } });
    const leaveFamily = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code: "VERIFICATION_REQUIRED", message: "server text" },
      })
      .mockResolvedValueOnce({ data: { ok: true } });
    const onLogout = vi.fn();
    render(
      <SettingsLeaveFamilySection
        familyId={FAMILY_ID}
        userId={USER_ID}
        apiClient={{ getVerifyMethod, leaveFamily } as unknown as ApiClient}
        onLogout={onLogout}
      />,
    );
    await openConfirm();

    await settledClick(screen.getByRole("button", { name: "確定離開" }));

    expect(
      screen.getByText(currentSecretPrompt("pin", "leave")),
    ).toBeInTheDocument();
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    await enterPin();
    expect(leaveFamily).toHaveBeenLastCalledWith(FAMILY_ID, USER_ID, SECRET);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable copy above 確定離開 when the re-read is not PIN / pattern", async () => {
    const { onLogout } = renderSection(answers("none"), {
      error: { code: "VERIFICATION_REQUIRED", message: "server text" },
    });
    await openConfirm();

    await settledClick(screen.getByRole("button", { name: "確定離開" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      CURRENT_SECRET_UNAVAILABLE_MESSAGE,
    );
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "確定離開" }),
    ).toBeInTheDocument();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
