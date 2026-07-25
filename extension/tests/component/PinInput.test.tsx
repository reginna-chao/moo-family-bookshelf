import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PinInput } from "@/dialog/PinInput";

function getInput(): HTMLInputElement {
  return screen.getByLabelText("PIN 碼輸入") as HTMLInputElement;
}

function getSubmitButton(): HTMLElement {
  return screen.getByText("確認");
}

describe("PinInput", () => {
  describe("verify mode", () => {
    it("renders a single password input", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      const input = getInput();
      expect(input).toBeInTheDocument();
      expect(input.type).toBe("password");
      expect(input.inputMode).toBe("numeric");
    });

    it("shows the verify label", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
    });

    it("shows length hint", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      expect(screen.getByText("6-12 位數字")).toBeInTheDocument();
    });

    it("renders a confirm button", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      expect(getSubmitButton()).toBeInTheDocument();
    });

    it("calls onComplete when a valid PIN is submitted", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledWith("123456");
    });

    it("calls onComplete on Enter key", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "654321" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onComplete).toHaveBeenCalledWith("654321");
    });

    it("accepts PINs up to 12 digits", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "123456789012" } });
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledWith("123456789012");
    });

    it("rejects PINs shorter than 6 digits", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "1234" } });
      fireEvent.click(getSubmitButton());

      expect(onComplete).not.toHaveBeenCalled();
      expect(screen.getByText("PIN 碼長度須為 6-12 位數")).toBeInTheDocument();
    });

    it("rejects non-digit input", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "abc123" } });
      expect(input.value).toBe("");
    });

    it("truncates input beyond 12 digits", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      const input = getInput();

      fireEvent.change(input, { target: { value: "1234567890123" } });
      // Should not accept — value stays at previous
      expect(input.value).toBe("");
    });

    it("displays external error", () => {
      render(
        <PinInput mode="verify" onComplete={vi.fn()} error="PIN 碼錯誤" />,
      );
      expect(screen.getByText("PIN 碼錯誤")).toBeInTheDocument();
    });
  });

  describe("disabled prop", () => {
    it("marks the input and confirm button as disabled when disabled", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} disabled />);
      expect(getInput()).toBeDisabled();
      expect(getSubmitButton()).toBeDisabled();
    });

    it("does not call onComplete on submit while disabled", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} disabled />);
      // handleSubmit bails out early when disabled, so even a valid PIN is ignored.
      fireEvent.click(getSubmitButton());
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("keeps the input and button interactive when disabled is omitted (default false)", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      expect(getInput()).not.toBeDisabled();
      expect(getSubmitButton()).not.toBeDisabled();

      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());
      expect(onComplete).toHaveBeenCalledWith("123456");
    });
  });

  describe("setup mode", () => {
    it("shows enter label first, then confirm label after submit", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();

      const input = getInput();
      fireEvent.change(input, { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
    });

    it("calls onComplete only when confirm matches", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      // Enter first PIN
      fireEvent.change(getInput(), { target: { value: "567890" } });
      fireEvent.click(getSubmitButton());

      // Confirm with same PIN
      fireEvent.change(getInput(), { target: { value: "567890" } });
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledWith("567890");
    });

    it("shows mismatch error when confirm does not match", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      // Enter first PIN
      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      // Enter different confirm PIN
      fireEvent.change(getInput(), { target: { value: "654321" } });
      fireEvent.click(getSubmitButton());

      expect(screen.getByText("PIN 碼不一致，請重新輸入")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("clears input after mismatch", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);

      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      fireEvent.change(getInput(), { target: { value: "999999" } });
      fireEvent.click(getSubmitButton());

      expect(getInput().value).toBe("");
    });

    it("shows reset button during confirm step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);

      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      const resetBtn = screen.getByText("重新設定");
      expect(resetBtn).toBeInTheDocument();

      fireEvent.click(resetBtn);
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
    });

    it("does not show reset button during enter step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      expect(screen.queryByText("重新設定")).not.toBeInTheDocument();
    });

    it("validates length in setup mode too", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      fireEvent.change(getInput(), { target: { value: "12" } });
      fireEvent.click(getSubmitButton());

      expect(screen.getByText("PIN 碼長度須為 6-12 位數")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });
});
