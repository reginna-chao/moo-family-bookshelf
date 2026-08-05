import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VerificationPrompt } from "@/dialog/VerificationPrompt";
import type { VerificationPromptProps } from "@/dialog/VerificationPrompt";
// The prompt renders these formatters, so asserting through them hits the real
// render site. The literals themselves are pinned in
// tests/unit/dialog/verificationMessages.test.ts.
import {
  rateLimitedMessage,
  verificationLockedMessage,
} from "@/dialog/verificationMessages";
import { dimmedAncestor } from "./helpers/dimStyle";

function renderPrompt(overrides: Partial<VerificationPromptProps> = {}) {
  const props: VerificationPromptProps = {
    method: "pin",
    methodError: false,
    error: "",
    locked: false,
    submitting: false,
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<VerificationPrompt {...props} />);
  return props;
}

/** Simulate a valid pattern draw on the PatternLock SVG (viewBox 200x200). */
function drawPattern(svg: Element, dotIndices: number[]) {
  const SPACING = 200 / 3;
  const OFFSET = SPACING / 2;
  const posOf = (index: number) => ({
    clientX: (index % 3) * SPACING + OFFSET,
    clientY: Math.floor(index / 3) * SPACING + OFFSET,
  });
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 200,
    bottom: 200,
    width: 200,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.mouseDown(svg, posOf(dotIndices[0]));
  for (let i = 1; i < dotIndices.length; i++) {
    fireEvent.mouseMove(svg, posOf(dotIndices[i]));
  }
  fireEvent.mouseUp(svg);
}

/** Distinguishing fragment of the OTP-guidance copy shown for a genuine "code". */
const OTP_GUIDANCE_FRAGMENT = "此帳號使用一次性驗證碼";

/** Copy shown when the method cannot be loaded for an active challenge. */
const METHOD_LOAD_ERROR = "無法載入驗證方式，請稍後再試";

describe("VerificationPrompt", () => {
  it("renders the PIN input when method is 'pin'", () => {
    renderPrompt({ method: "pin" });
    expect(screen.getByLabelText("PIN 碼輸入")).toBeInTheDocument();
    expect(screen.queryByText(OTP_GUIDANCE_FRAGMENT)).not.toBeInTheDocument();
  });

  it("renders the pattern lock when method is 'pattern'", () => {
    renderPrompt({ method: "pattern" });
    expect(screen.getByText("請繪製解鎖圖形")).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

  it("renders OTP guidance text and no secret input for a genuine 'code' method", () => {
    renderPrompt({ method: "code" });
    expect(
      screen.getByText(new RegExp(OTP_GUIDANCE_FRAGMENT)),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("請繪製解鎖圖形")).not.toBeInTheDocument();
  });

  it("renders the load-error message (not OTP guidance) when method is 'none'", () => {
    renderPrompt({ method: "none" });
    expect(screen.getByText(METHOD_LOAD_ERROR)).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(OTP_GUIDANCE_FRAGMENT)),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("請繪製解鎖圖形")).not.toBeInTheDocument();
  });

  it("renders the load-error message and no secret input when methodError is true", () => {
    // methodError wins even if a stale method value is present.
    renderPrompt({ method: null, methodError: true });
    expect(screen.getByText(METHOD_LOAD_ERROR)).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(OTP_GUIDANCE_FRAGMENT)),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("載入中...")).not.toBeInTheDocument();
  });

  it("shows the static locked message when locked without a countdown", () => {
    renderPrompt({ method: "pin", locked: true });
    expect(
      screen.getByText(verificationLockedMessage(null)),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

  it("shows the remaining lockout time when countdownSeconds is provided", () => {
    renderPrompt({ method: "pin", locked: true, countdownSeconds: 90 });
    // Live variant ("...請於 1 分 30 秒後再試") replaces the static wording.
    expect(screen.getByText(verificationLockedMessage(90))).toBeInTheDocument();
    expect(
      screen.queryByText(verificationLockedMessage(null)),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

  it("shows the rate-limit countdown over the static error while unlocked", () => {
    // A 429 quota wait keeps the input rendered; the ticking message supersedes
    // whatever static error the controller last stored.
    renderPrompt({
      method: "pin",
      error: "驗證失敗，請重新輸入",
      countdownSeconds: 45,
    });
    expect(screen.getByText(rateLimitedMessage(45))).toBeInTheDocument();
    expect(screen.queryByText("驗證失敗，請重新輸入")).not.toBeInTheDocument();
    expect(screen.getByLabelText("PIN 碼輸入")).toBeInTheDocument();
  });

  it("keeps the static error when countdownSeconds is null", () => {
    renderPrompt({
      method: "pin",
      error: "驗證失敗，請重新輸入",
      countdownSeconds: null,
    });
    expect(screen.getByText("驗證失敗，請重新輸入")).toBeInTheDocument();
    expect(screen.queryByText(rateLimitedMessage(45))).not.toBeInTheDocument();
  });

  /**
   * While an (unlocked) rate-limit countdown ticks the server window has not
   * cleared yet, so any submit is a guaranteed 429. The widget must therefore be
   * inert for the whole wait — and become usable again on its own once the hook
   * resets countdownSeconds to null, with no extra state to unwind.
   */
  describe("rate-limit countdown input lockout", () => {
    it("disables the PIN input and 確認 button while the countdown ticks", () => {
      renderPrompt({ method: "pin", countdownSeconds: 45, submitting: false });

      expect(screen.getByLabelText("PIN 碼輸入")).toBeDisabled();
      expect(screen.getByText("確認")).toBeDisabled();
    });

    it("does not submit a PIN while the countdown ticks", () => {
      const props = renderPrompt({ method: "pin", countdownSeconds: 45 });

      fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByText("確認"));

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("does not fire onSubmit from a pattern draw while the countdown ticks", () => {
      const props = renderPrompt({ method: "pattern", countdownSeconds: 45 });

      // A full 4-dot draw that would normally complete the pattern.
      drawPattern(screen.getByRole("application"), [0, 3, 6, 7]);

      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("shows no '驗證中...' overlay for a countdown alone (only an in-flight submit)", () => {
      renderPrompt({ method: "pin", countdownSeconds: 45, submitting: false });

      // The overlay stays keyed on `submitting`: a waiting user is blocked, not
      // "verifying", and the 返回 button must remain usable.
      expect(screen.queryByText("驗證中...")).not.toBeInTheDocument();
      expect(document.querySelector('[aria-live="polite"]')).toBeNull();
      expect(screen.getByText("返回")).toBeEnabled();
    });

    it.each([
      ["undefined (prop omitted)", {}],
      ["null", { countdownSeconds: null }],
    ])(
      "keeps the PIN input usable when countdownSeconds is %s",
      (_label, overrides: Partial<VerificationPromptProps>) => {
        renderPrompt({ method: "pin", submitting: false, ...overrides });

        expect(screen.getByLabelText("PIN 碼輸入")).toBeEnabled();
        expect(screen.getByText("確認")).toBeEnabled();
      },
    );

    // The countdown message is the ONLY text telling the user why input is
    // locked, so it must stay at full opacity while the disabled widget dims.
    it.each([
      [
        "PIN",
        { method: "pin" as const },
        () => screen.getByLabelText("PIN 碼輸入"),
      ],
      [
        "pattern",
        { method: "pattern" as const },
        () => screen.getByRole("application"),
      ],
    ])(
      "keeps the rate-limit message readable outside the dimmed %s widget",
      (_label, overrides, getWidget) => {
        renderPrompt({ ...overrides, countdownSeconds: 45 });

        expect(
          dimmedAncestor(screen.getByText(rateLimitedMessage(45))),
        ).toBeNull();
        // Sanity: the widget the user cannot use IS dimmed.
        expect(dimmedAncestor(getWidget())).not.toBeNull();
      },
    );

    it("fires onSubmit from a pattern draw once the countdown has cleared", () => {
      const props = renderPrompt({ method: "pattern", countdownSeconds: null });

      drawPattern(screen.getByRole("application"), [0, 3, 6, 7]);

      expect(props.onSubmit).toHaveBeenCalledWith("0,3,6,7");
    });
  });

  // The locked / method-load / "none" branches render an error line as the WHOLE
  // challenge slot, so they need their own bottom gap before the 返回 button
  // (the PIN/pattern widgets bring their own spacing). jsdom applies no CSS, so
  // the class list is the contract.
  it.each([
    ["locked", { method: "pin" as const, locked: true }],
    ["method load error", { method: null, methodError: true }],
    ["method 'none'", { method: "none" as const }],
  ])(
    "renders the %s message with the gapped error class",
    (_label, overrides: Partial<VerificationPromptProps>) => {
      renderPrompt(overrides);
      const message = document.querySelector(".moo-secret-entry__error");
      expect(message).not.toBeNull();
      expect(message).toHaveClass("moo-secret-entry__error--gap16");
    },
  );

  it("shows a loading state while the method is still null", () => {
    renderPrompt({ method: null });
    expect(screen.getByText("載入中...")).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

  it("calls onCancel when the 返回 button is clicked", () => {
    const props = renderPrompt();
    fireEvent.click(screen.getByText("返回"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it("forwards the entered secret to onSubmit", () => {
    const props = renderPrompt({ method: "pin" });
    fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByText("確認"));
    expect(props.onSubmit).toHaveBeenCalledWith("123456");
  });

  it("surfaces an external error on the PIN input", () => {
    renderPrompt({ method: "pin", error: "驗證失敗，請重新輸入" });
    expect(screen.getByText("驗證失敗，請重新輸入")).toBeInTheDocument();
  });

  it("disables the 返回 button while submitting", () => {
    renderPrompt({ method: "pin", submitting: true });
    expect(screen.getByText("返回")).toBeDisabled();
  });

  it("disables the PIN input and 確認 button while submitting", () => {
    renderPrompt({ method: "pin", submitting: true });
    expect(screen.getByLabelText("PIN 碼輸入")).toBeDisabled();
    expect(screen.getByText("確認")).toBeDisabled();
  });

  it("does not submit a PIN via the disabled 確認 button while submitting", () => {
    const props = renderPrompt({ method: "pin", submitting: true });
    fireEvent.change(screen.getByLabelText("PIN 碼輸入"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByText("確認"));
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("does not fire onSubmit from a pattern draw while submitting", () => {
    const props = renderPrompt({ method: "pattern", submitting: true });
    // A full 4-dot draw that would normally complete the pattern.
    drawPattern(screen.getByRole("application"), [0, 3, 6, 7]);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("fires onSubmit from a pattern draw when not submitting (guard is off by default)", () => {
    const props = renderPrompt({ method: "pattern", submitting: false });
    drawPattern(screen.getByRole("application"), [0, 3, 6, 7]);
    expect(props.onSubmit).toHaveBeenCalledWith("0,3,6,7");
  });

  it("shows the '驗證中...' overlay inside an aria-live region while submitting a pattern", () => {
    renderPrompt({ method: "pattern", submitting: true });
    const status = screen.getByText("驗證中...");
    // The submit feedback lives inside the polite live region (centered overlay).
    const liveRegion = status.closest('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toContainElement(status);
    // The old bottom status line must NOT be used for the pattern path anymore.
    expect(document.querySelector(".moo-verify__status--saving")).toBeNull();
  });

  it("shows the '驗證中...' overlay inside an aria-live region while submitting a PIN", () => {
    renderPrompt({ method: "pin", submitting: true });
    const status = screen.getByText("驗證中...");
    const liveRegion = status.closest('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion).toContainElement(status);
    expect(document.querySelector(".moo-verify__status--saving")).toBeNull();
  });

  it("does not render the '驗證中...' overlay when not submitting", () => {
    renderPrompt({ method: "pattern", submitting: false });
    expect(screen.queryByText("驗證中...")).not.toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toBeNull();
  });

  it("keeps the 'code' path on the bottom status line (not the aria-live overlay) while submitting", () => {
    renderPrompt({ method: "code", submitting: true });
    const status = screen.getByText("驗證中...");
    // OTP guidance path is unchanged: still the bottom saving status, no overlay.
    expect(status.closest(".moo-verify__status--saving")).not.toBeNull();
    expect(status.closest('[aria-live="polite"]')).toBeNull();
  });

  it("renders the moo-onboarding-view wrapper (targeted by the modal zero-padding override)", () => {
    // The reauth prompt lives inside `.moo-modal`; the `.moo-modal
    // .moo-onboarding-view { padding: 0 }` override only applies if the prompt's
    // root actually carries this wrapper class. Pin it so the selector keeps matching.
    const { container } = render(
      <VerificationPrompt
        method="pin"
        methodError={false}
        error=""
        locked={false}
        submitting={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstElementChild).toHaveClass("moo-onboarding-view");
  });

  // The 返回 button was re-based on the shared `.moo-button` component class
  // (full-width outline variant) instead of restating the button chrome in
  // `.moo-onboarding-view__secondary`. jsdom does not apply the stylesheet, so
  // the class list is the contract that keeps the shared base from being dropped.
  it("opts the 返回 button into the shared full-width outline button base", () => {
    renderPrompt({ method: "pin" });

    const back = screen.getByText("返回");
    expect(back).toHaveClass("moo-button");
    expect(back).toHaveClass("moo-button--outline");
    expect(back).toHaveClass("moo-button--block");
    // The view-specific class is kept alongside the base (additive refactor).
    expect(back).toHaveClass("moo-onboarding-view__secondary");
  });
});
