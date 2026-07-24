import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VerificationPrompt } from "@/dialog/VerificationPrompt";
import type { VerificationPromptProps } from "@/dialog/VerificationPrompt";

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

  it("shows the locked message when locked, hiding any secret input", () => {
    renderPrompt({ method: "pin", locked: true });
    expect(screen.getByText("驗證已鎖定，請稍後再試")).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
  });

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
