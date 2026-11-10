import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
  CURRENT_SECRET_UNAVAILABLE_MESSAGE,
  currentSecretPrompt,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import type { ApiClient } from "@/api/client";
import type { ApiResponse, VerifyMethod } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/constants";
import { FamilySettingsLeaveBlock } from "@/dialog/FamilySettingsLeaveBlock";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * FamilySettingsLeaveBlock step-up: 離開家庭 reads the verify method once; on a PIN / pattern account
 * the confirm step shows the current-secret entry (`purpose="leave"`) under 確定要離開嗎？, the entry's
 * own 確認 sends the leave with that secret, and the plain 確定離開 is hidden (取消 stays). A wrong
 * secret keeps the confirm step open with the method's wrong-secret copy and an empty entry. A `none`
 * account, or a failed method read, keeps the old 確定離開 and leaves without a secret. 取消 also
 * clears an error shown in the confirm step. The old flow's copy (OWNER_CANNOT_LEAVE, already-left
 * codes) stays in FamilySettings.test.tsx and useFamilySettingsLeave.test.ts.
 *
 * Focus: a refused secret remounts the entry (the confirm step leaves the tree while the leave is in
 * flight), and the removed frame had focus — so the entry shown AGAIN takes focus, while the first one
 * does not. jsdom's `document.activeElement` is the truth: `tests/helpers/secureFrameStub.tsx` hands
 * the host's `autoFocus` to the inline view, which focuses the PIN field / the pattern wrapper.
 */

const PIN_PROMPT = "離開家庭前，請先輸入目前的 PIN 碼。";
type LeaveRes = ApiResponse<{ ok: boolean }>;
type MethodRead = VerifyMethod | "throw";

/** `method`: one answer for every method read, or one per read in order (the last one repeats). */
function renderBlock(method: MethodRead | MethodRead[], responses: LeaveRes[]) {
  const reads = Array.isArray(method) ? [...method] : [method];
  const getVerifyMethod = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift()! : reads[0];
    if (next === "throw") throw new Error("offline");
    return { data: { method: next } };
  });
  const leaveFamily = vi.fn(async () => responses.shift()!);
  const onLeave = vi.fn();
  const api = {
    getVerifyMethod,
    leaveFamily,
    getEndpoint: () => "https://api.example",
  } as unknown as ApiClient;
  render(
    <FamilySettingsLeaveBlock
      familyId="fam-1"
      userId="user-1"
      apiClient={api}
      onLeave={onLeave}
    />,
  );
  return { getVerifyMethod, leaveFamily, onLeave };
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

/** True when any `browser.storage.local.set` call so far carried `secret`. */
function storageSawSecret(secret: string): boolean {
  return vi
    .mocked(chrome.storage.local.set)
    .mock.calls.some((call) => JSON.stringify(call[0]).includes(secret));
}

describe("FamilySettingsLeaveBlock step-up", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("asks a PIN account for its current PIN instead of a plain confirm", async () => {
    const { getVerifyMethod, leaveFamily } = renderBlock("pin", []);

    await click("離開家庭");

    expect(getVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText("確定要離開嗎？")).toBeInTheDocument();
    expect(screen.getByText(PIN_PROMPT)).toBeInTheDocument();
    expect(currentSecretPrompt("pin", "leave")).toBe(PIN_PROMPT);
    expect(screen.getByLabelText("PIN 碼輸入")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "確定離開" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(leaveFamily).not.toHaveBeenCalled();
  });

  it("leaves with the entered PIN and never stores it", async () => {
    const { leaveFamily, onLeave } = renderBlock("pin", [
      { data: { ok: true } },
    ]);

    await click("離開家庭");
    await submitPin("482913");

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "482913");
    expect(onLeave).toHaveBeenCalledTimes(1);
    // Positive companion: the departure mark write proves the spy sees this flow's writes.
    const keys = vi
      .mocked(chrome.storage.local.set)
      .mock.calls.flatMap((call) => Object.keys(call[0] as object));
    expect(keys).toContain(SELF_DEPARTURE_UNTIL_KEY);
    expect(storageSawSecret("482913")).toBe(false);
  });

  it("keeps the confirm step open with the wrong-PIN copy and an empty entry", async () => {
    const { leaveFamily, onLeave } = renderBlock("pin", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
      { data: { ok: true } },
    ]);

    await click("離開家庭");
    await submitPin("000000");

    expect(screen.getByText("確定要離開嗎？")).toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toHaveValue("");
    expect(screen.queryByText("server text")).not.toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();

    await submitPin("482913");
    expect(leaveFamily).toHaveBeenLastCalledWith("fam-1", "user-1", "482913");
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("asks a pattern account to draw its current pattern", async () => {
    const { leaveFamily } = renderBlock("pattern", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
    ]);

    await click("離開家庭");
    expect(
      screen.getByText("離開家庭前，請先畫出目前的圖形。"),
    ).toBeInTheDocument();
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", "0,3,6,7");
    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
  });

  it.each<[string, VerifyMethod | "throw"]>([
    ["a none account", "none"],
    ["a failed method read", "throw"],
  ])("keeps the plain confirm for %s", async (_label, method) => {
    const { leaveFamily, onLeave } = renderBlock(method, [
      { data: { ok: true } },
    ]);

    await click("離開家庭");
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
    expect(screen.queryByText(PIN_PROMPT)).toBeNull();
    await click("確定離開");

    expect(leaveFamily).toHaveBeenCalledWith("fam-1", "user-1", undefined);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("returns to 離開家庭 on cancel without sending anything", async () => {
    const { leaveFamily } = renderBlock("pin", []);

    await click("離開家庭");
    await click("取消");

    expect(
      screen.getByRole("button", { name: "離開家庭" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).toBeNull();
    expect(leaveFamily).not.toHaveBeenCalled();
  });

  it("clears the confirm step's error on cancel", async () => {
    renderBlock("none", [
      { error: { code: "VERIFICATION_REQUIRED", message: "server text" } },
    ]);

    await click("離開家庭");
    await click("確定離開");
    expect(
      screen.getByText(CURRENT_SECRET_UNAVAILABLE_MESSAGE),
    ).toBeInTheDocument();
    await click("取消");

    expect(screen.queryByText(CURRENT_SECRET_UNAVAILABLE_MESSAGE)).toBeNull();
    expect(
      screen.getByRole("button", { name: "離開家庭" }),
    ).toBeInTheDocument();
  });
});

/** The pattern view's focus target: the stub's inline view root (the wrapper around the grid). */
function patternFocusTarget(): Element | null {
  return (
    document.querySelector('[data-secure-frame-stub="pattern"]')
      ?.firstElementChild ?? null
  );
}

describe("FamilySettingsLeaveBlock entry focus", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("does not focus the PIN entry on its first display", async () => {
    renderBlock("pin", []);

    await click("離開家庭");

    expect(screen.getByLabelText("PIN 碼輸入")).not.toBe(
      document.activeElement,
    );
  });

  it("focuses the PIN entry shown again after a wrong PIN", async () => {
    renderBlock("pin", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
    ]);

    await click("離開家庭");
    const first = screen.getByLabelText("PIN 碼輸入");
    await submitPin("000000");

    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    // The entry was remounted, so the frame that had focus is gone.
    expect(first.isConnected).toBe(false);
    expect(screen.getByLabelText("PIN 碼輸入")).toBe(document.activeElement);
  });

  it.each<[string, MethodRead]>([
    ["reads as none", "none"],
    ["cannot be read", "throw"],
  ])(
    "focuses the PIN entry kept after a sent PIN whose method then %s",
    async (_label, reread) => {
      renderBlock(
        ["pin", reread],
        [{ error: { code: "VERIFICATION_REQUIRED", message: "server text" } }],
      );

      await click("離開家庭");
      await submitPin("482913");

      // Only the confirm step's error is set: the entry's own error stays empty.
      expect(
        screen.getByText(CURRENT_SECRET_UNAVAILABLE_MESSAGE),
      ).toBeInTheDocument();
      expect(screen.getByText(PIN_PROMPT)).toBeInTheDocument();
      expect(screen.getByLabelText("PIN 碼輸入")).toBe(document.activeElement);
    },
  );

  it("focuses the pattern entry shown again after a wrong pattern, not the first one", async () => {
    renderBlock("pattern", [
      { error: { code: "VERIFICATION_FAILED", message: "server text" } },
    ]);

    await click("離開家庭");
    expect(patternFocusTarget()).not.toBeNull();
    expect(patternFocusTarget()).not.toBe(document.activeElement);
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(patternFocusTarget()).toBe(document.activeElement);
  });
});
