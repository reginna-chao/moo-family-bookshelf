import { act, fireEvent, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CURRENT_PATTERN_WRONG_MESSAGE,
  CURRENT_PIN_WRONG_MESSAGE,
} from "moo-family-bookshelf-shared/verifyInput/messages";
import {
  pickMethod,
  renderVerifySettings,
  submitPin,
} from "./helpers/verifySettingsStepUp";
import { drawPattern, patternConfirmButton } from "./helpers/patternGrid";

/**
 * VerificationSettings current-secret entry focus. A refused save brings the current-secret step back
 * (the step left the tree once the secret was entered), and the removed frame had focus — so the entry
 * shown AGAIN with the refusal's error takes focus, while its first display does not, nor does the
 * step a `VERIFICATION_REQUIRED` re-read opens without an error (no secret was sent, nothing had
 * focus). jsdom's `document.activeElement` is the truth: `tests/helpers/secureFrameStub.tsx` hands the
 * host's `autoFocus` to the inline view, which focuses the PIN field / the pattern wrapper.
 */

const CURRENT = "111111";
const PROMPT = "要更改登入驗證，請先輸入目前的 PIN 碼。";

function refusal(code: string) {
  return { error: { code, message: "server text" } };
}

/** The focus target of the inline pattern view: its wrapper, the stub's first child. */
function patternFocusTarget(): Element | null {
  return (
    document.querySelector('[data-secure-frame-stub="pattern"]')
      ?.firstElementChild ?? null
  );
}

describe("VerificationSettings current-secret entry focus", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
  });

  it("does not focus the current PIN entry on its first display", async () => {
    await renderVerifySettings(["pin"], vi.fn());

    await pickMethod("PIN 碼");

    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).not.toBe(
      document.activeElement,
    );
  });

  it("focuses the current PIN entry shown again after a refused PIN change", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_FAILED"));
    await renderVerifySettings(["pin"], setVerifyMethod);

    await pickMethod("PIN 碼");
    await submitPin(CURRENT);
    await submitPin("222222");
    await submitPin("222222");

    expect(setVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toBe(document.activeElement);
  });

  it.each([
    ["隨機驗證碼", null],
    ["不設定驗證", "確定不設定驗證"],
  ])(
    "focuses the current PIN entry shown again after a refused %s save",
    async (label, confirm) => {
      const setVerifyMethod = vi
        .fn()
        .mockResolvedValue(refusal("VERIFICATION_FAILED"));
      await renderVerifySettings(["pin"], setVerifyMethod);

      await pickMethod(label);
      const first = screen.getByLabelText("PIN 碼輸入");
      await submitPin(CURRENT);
      if (confirm !== null) await pickMethod(confirm);

      expect(setVerifyMethod).toHaveBeenCalledTimes(1);
      expect(screen.getByText(CURRENT_PIN_WRONG_MESSAGE)).toBeInTheDocument();
      // The entry was remounted, so the frame that had focus is gone.
      expect(first.isConnected).toBe(false);
      expect(screen.getByLabelText("PIN 碼輸入")).toBe(document.activeElement);
    },
  );

  it("does not focus the current PIN entry a VERIFICATION_REQUIRED re-read opens", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_REQUIRED"));
    // The panel reads `none`; the server's re-read answers `pin`.
    await renderVerifySettings(["none", "pin"], setVerifyMethod);

    await pickMethod("隨機驗證碼");

    expect(setVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
    expect(screen.queryByText(CURRENT_PIN_WRONG_MESSAGE)).toBeNull();
    expect(screen.getByLabelText("PIN 碼輸入")).not.toBe(
      document.activeElement,
    );
  });

  it("focuses the current pattern entry shown again after a refused save, not the first one", async () => {
    const setVerifyMethod = vi
      .fn()
      .mockResolvedValue(refusal("VERIFICATION_FAILED"));
    await renderVerifySettings(["pattern"], setVerifyMethod);

    await pickMethod("隨機驗證碼");
    expect(patternFocusTarget()).not.toBeNull();
    expect(patternFocusTarget()).not.toBe(document.activeElement);
    drawPattern([0, 3, 6, 7]);
    await act(async () => {
      fireEvent.click(patternConfirmButton());
    });

    expect(setVerifyMethod).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CURRENT_PATTERN_WRONG_MESSAGE)).toBeInTheDocument();
    expect(patternFocusTarget()).toBe(document.activeElement);
  });
});
