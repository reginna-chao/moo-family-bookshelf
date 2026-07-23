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
    expect(screen.getByText(new RegExp(OTP_GUIDANCE_FRAGMENT))).toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("請繪製解鎖圖形")).not.toBeInTheDocument();
  });

  it("renders the load-error message (not OTP guidance) when method is 'none'", () => {
    renderPrompt({ method: "none" });
    expect(screen.getByText(METHOD_LOAD_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(OTP_GUIDANCE_FRAGMENT))).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PIN 碼輸入")).not.toBeInTheDocument();
    expect(screen.queryByText("請繪製解鎖圖形")).not.toBeInTheDocument();
  });

  it("renders the load-error message and no secret input when methodError is true", () => {
    // methodError wins even if a stale method value is present.
    renderPrompt({ method: null, methodError: true });
    expect(screen.getByText(METHOD_LOAD_ERROR)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(OTP_GUIDANCE_FRAGMENT))).not.toBeInTheDocument();
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
});
