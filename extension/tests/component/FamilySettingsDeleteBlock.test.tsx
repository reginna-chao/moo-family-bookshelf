import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import type { ApiResponse, VerifyMethod } from "@/api/types";
import { USER_ID_KEY } from "@/constants";
import { FamilySettingsDeleteBlock } from "@/dialog/FamilySettingsDeleteBlock";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * FamilySettingsDeleteBlock step-up (#396): 移除帳戶 reads the verify method once; on a PIN / pattern
 * account the confirm step shows the current-secret entry between the warning and the buttons, the
 * entry's own 確認 sends the delete with that secret, and the plain 確定移除 is hidden (取消 stays).
 * A wrong secret keeps the confirm step open with the method's wrong-secret copy and an empty entry.
 * A `none` account, or a failed method read, keeps the old 確定移除 and deletes without a secret.
 * The old flow's copy and the OWNER_CANNOT_DELETE path stay in FamilySettings.test.tsx.
 */

const PIN_PROMPT = "移除帳戶前，請先輸入目前的 PIN 碼。";
type DeleteRes = ApiResponse<{ ok: boolean }>;

function renderBlock(method: VerifyMethod | "throw", responses: DeleteRes[]) {
  const getVerifyMethod =
    method === "throw"
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue({ data: { method } });
  const deleteAccount = vi.fn(async () => responses.shift()!);
  const onLeave = vi.fn();
  const api = { getVerifyMethod, deleteAccount } as unknown as ApiClient;
  render(
    <FamilySettingsDeleteBlock
      userId="user-1"
      apiClient={api}
      onLeave={onLeave}
    />,
  );
  return { getVerifyMethod, deleteAccount, onLeave };
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

describe("FamilySettingsDeleteBlock step-up", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ [USER_ID_KEY]: "user-1" });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("asks a PIN account for its current PIN instead of a plain confirm", async () => {
    const { getVerifyMethod, deleteAccount } = renderBlock("pin", []);

    await click("移除帳戶");

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
    expect(screen.getByText(PIN_PROMPT)).toBeInTheDocument();
    expect(currentSecretPrompt("pin", "delete")).toBe(PIN_PROMPT);
    expect(screen.getByLabelText("PIN 碼輸入")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確定移除" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes with the entered PIN and leaves", async () => {
    const { deleteAccount, onLeave } = renderBlock("pin", [
      { data: { ok: true } },
    ]);

    await click("移除帳戶");
    await submitPin("482913");

    expect(deleteAccount).toHaveBeenCalledWith("user-1", "482913");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirm step open with the wrong-PIN copy and an empty entry", async () => {
    const { deleteAccount, onLeave } = renderBlock("pin", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
      { data: { ok: true } },
    ]);

    await click("移除帳戶");
    await submitPin("000000");

    expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveValue("");
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();

    await submitPin("482913");
    expect(deleteAccount).toHaveBeenLastCalledWith("user-1", "482913");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const { deleteAccount } = renderBlock("pattern", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
    ]);

    await click("移除帳戶");
    expect(
      screen.getByText("移除帳戶前，請先畫出目前的圖形。"),
    ).toBeInTheDocument();
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(deleteAccount).toHaveBeenCalledWith("user-1", "0,3,6,7");
    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
  });

  it.each<[string, VerifyMethod | "throw"]>([
    ["a none account", "none"],
    ["a failed method read", "throw"],
  ])("keeps the plain confirm for %s", async (_label, method) => {
    const { deleteAccount, onLeave } = renderBlock(method, [
      { data: { ok: true } },
    ]);

    await click("移除帳戶");
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
    expect(screen.queryByText(PIN_PROMPT)).toBeNull();
    await click("確定移除");

    expect(deleteAccount).toHaveBeenCalledWith("user-1", undefined);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("returns to 移除帳戶 on cancel without sending anything", async () => {
    const { deleteAccount } = renderBlock("pin", []);

    await click("移除帳戶");
    await click("取消");

    expect(
      screen.getByRole("button", { name: "移除帳戶" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});
