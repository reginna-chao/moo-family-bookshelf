import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PinInput } from "@/dialog/PinInput";
import { dimmedAncestor, dimmedElements } from "./helpers/dimStyle";

function getInput(): HTMLInputElement {
  return screen.getByLabelText("PIN 碼輸入") as HTMLInputElement;
}

function getSubmitButton(): HTMLElement {
  return screen.getByText("確認");
}

function getResetButton(): HTMLElement {
  return screen.getByText("重新設定");
}

/** Advance a setup-mode PinInput to the confirm step, where 重新設定 renders. */
function advanceToConfirmStep(): void {
  fireEvent.change(getInput(), { target: { value: "123456" } });
  fireEvent.click(getSubmitButton());
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

    /**
     * 重新設定 sits OUTSIDE the dimmed wrapper (so it stays readable during a
     * lockout countdown), which means `pointerEvents: none` does not cover it.
     * It therefore needs its own `disabled` — otherwise a locked-out user could
     * still wipe the first PIN and restart the setup mid-lockout.
     */
    it("marks the setup reset button as disabled while disabled", () => {
      const { rerender } = render(
        <PinInput mode="setup" onComplete={vi.fn()} />,
      );
      advanceToConfirmStep();

      rerender(<PinInput mode="setup" onComplete={vi.fn()} disabled />);

      expect(getResetButton()).toBeDisabled();
    });

    it("does not return to the enter step when the reset button is clicked while disabled", () => {
      const { rerender } = render(
        <PinInput mode="setup" onComplete={vi.fn()} />,
      );
      advanceToConfirmStep();
      rerender(<PinInput mode="setup" onComplete={vi.fn()} disabled />);

      fireEvent.click(getResetButton());

      // Still on the confirm step — the reset never ran.
      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
      expect(screen.queryByText("設定 PIN 碼")).not.toBeInTheDocument();
    });

    it("keeps the setup reset button enabled and working when disabled is omitted", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      advanceToConfirmStep();

      expect(getResetButton()).not.toBeDisabled();

      fireEvent.click(getResetButton());
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
    });
  });

  /**
   * The dim wraps ONLY the interactive cluster (label / hint / input /
   * 確認). The error line is what explains the lock during a rate-limit
   * countdown, so it — and the reset button — must stay readable at full
   * opacity for the whole wait.
   */
  describe("disabled dim scope", () => {
    it("dims the input and confirm button while disabled", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} disabled />);

      expect(dimmedAncestor(getInput())).not.toBeNull();
      expect(dimmedAncestor(getSubmitButton())).not.toBeNull();
    });

    it("keeps the error line outside the dimmed cluster while disabled", () => {
      render(
        <PinInput
          mode="verify"
          onComplete={vi.fn()}
          disabled
          error="PIN 碼錯誤"
        />,
      );

      expect(dimmedAncestor(screen.getByText("PIN 碼錯誤"))).toBeNull();
    });

    it("renders no dimmed wrapper at all when enabled", () => {
      const { container } = render(
        <PinInput mode="verify" onComplete={vi.fn()} error="PIN 碼錯誤" />,
      );

      expect(dimmedElements(container)).toHaveLength(0);
    });

    it("keeps the reset button outside the dimmed cluster while disabled", () => {
      const { rerender } = render(
        <PinInput mode="setup" onComplete={vi.fn()} />,
      );
      // Advance to the confirm step so 重新設定 renders, then lock the widget.
      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());
      rerender(
        <PinInput
          mode="setup"
          onComplete={vi.fn()}
          disabled
          error="PIN 碼錯誤"
        />,
      );

      expect(dimmedAncestor(screen.getByText("重新設定"))).toBeNull();
      expect(dimmedAncestor(screen.getByText("PIN 碼錯誤"))).toBeNull();
      // Sanity: the widget the user cannot use IS dimmed.
      expect(dimmedAncestor(getInput())).not.toBeNull();
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

  /**
   * Moving to the confirm step defers a refocus by a 0ms timer, because the
   * field can only be refocused after the re-render that clears it. Closing the
   * widget before that tick must cancel the timer, or the callback runs on a
   * dead component and reaches through a ref React has already detached.
   *
   * Timer discipline: the render settles on the REAL clock first; the fake one
   * goes in only to hold the 0ms timer PENDING at unmount. Every assertion past
   * that point is synchronous — an RTL waiter cannot see vi's clock and would
   * poll a frozen one until the test times out.
   */
  describe("deferred refocus cleanup", () => {
    /**
     * Undoes the clearTimeout spy while the FAKE clearTimeout is still on
     * globalThis; restoring after `useRealTimers()` would strand the fake there
     * for every later test. Hence: restore, then swap the clock back.
     */
    let restoreClearTimeout = () => {};

    afterEach(() => {
      restoreClearTimeout();
      restoreClearTimeout = () => {};
      vi.useRealTimers();
    });

    it("clears the pending refocus timer when the widget unmounts", () => {
      const { unmount } = render(
        <PinInput mode="setup" onComplete={vi.fn()} />,
      );

      vi.useFakeTimers();

      fireEvent.change(getInput(), { target: { value: "123456" } });
      fireEvent.click(getSubmitButton());

      // Reaching the confirm step is what arms the deferred refocus.
      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // Spy only from here, so an arming clear cannot pass for the cleanup one.
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      restoreClearTimeout = () => clearSpy.mockRestore();

      unmount();

      expect(clearSpy).toHaveBeenCalled();
      // Nothing outlives the widget, so the refocus can never run on a dead ref.
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
