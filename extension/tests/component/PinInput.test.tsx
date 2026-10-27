import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PinInput } from "@/dialog/PinInput";
import { dimmedAncestor, dimmedElements } from "./helpers/dimStyle";

/**
 * PinInput: verify and setup modes, the disabled / dimmed states, and the deferred refocus.
 *
 * Twin contract (#385): `extension/src/dialog/PinInput.tsx` and `pwa/src/components/PinInput.tsx`
 * are a `必須一致（行為測試）` pair (`.claude/rules/frontend.md` → Extension ↔ PWA twins). The
 * `describe("twin contract (#385)")` block here and its namesake in `pwa/tests/component/PinInput.test.tsx`
 * carry identically titled cases with the same input and the same expected strings — edit both or
 * neither. The literals are pinned against `shared/src/verifyInput/` in
 * `extension/tests/unit/verifyInputRules.test.ts`.
 *
 * Short PINs: since #385 a PIN under 6 digits disables 確認 and makes Enter a no-op instead of
 * showing an error, so those cases assert that NO error line (`.moo-secret-entry__error`) renders;
 * "displays external error" is the positive companion pinning that selector.
 *
 * Deferred refocus cleanup: moving to the confirm step defers a refocus by a 0ms timer, because the
 * field can only be refocused after the re-render that clears it. Closing the widget before that tick
 * must cancel the timer, or the callback runs on a dead component and reaches through a ref React has
 * already detached. Timer discipline: the render settles on the REAL clock first; the fake one goes in
 * only to hold the 0ms timer PENDING at unmount. Every assertion past that point is synchronous — an
 * RTL waiter cannot see vi's clock and would poll a frozen one until the test times out.
 * restoreClearTimeout undoes the clearTimeout spy while the FAKE clearTimeout is still on globalThis;
 * restoring after `useRealTimers()` would strand the fake there for every later test — hence restore,
 * then swap the clock back.
 */

const PIN_MISMATCH = "兩次輸入的 PIN 碼不一致，請重新輸入。";
const EXTERNAL_ERROR = "伺服器錯誤";

function getInput(): HTMLInputElement {
  return screen.getByLabelText("PIN 碼輸入") as HTMLInputElement;
}

function getSubmitButton(): HTMLElement {
  return screen.getByRole("button", { name: "確認" });
}

function getResetButton(): HTMLElement {
  return screen.getByText("重新設定");
}

function typePin(value: string): void {
  fireEvent.change(getInput(), { target: { value } });
}

function pressEnter(): void {
  fireEvent.keyDown(getInput(), { key: "Enter", code: "Enter" });
}

function errorLine(): Element | null {
  return document.querySelector(".moo-secret-entry__error");
}

/** Advance a setup-mode PinInput to the confirm step, where 重新設定 renders. */
function advanceToConfirmStep(): void {
  typePin("123456");
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

      typePin("123456");
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledWith("123456");
    });

    it("calls onComplete on Enter key", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);

      typePin("654321");
      pressEnter();

      expect(onComplete).toHaveBeenCalledWith("654321");
    });

    it("accepts PINs up to 12 digits", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);

      typePin("123456789012");
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledWith("123456789012");
    });

    it("keeps 確認 disabled and shows no error for PINs shorter than 6 digits", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);

      typePin("1234");

      expect(getSubmitButton()).toBeDisabled();
      fireEvent.click(getSubmitButton());
      pressEnter();
      expect(onComplete).not.toHaveBeenCalled();
      expect(errorLine()).toBeNull();
      expect(screen.queryByText(/PIN 碼長度須為/)).not.toBeInTheDocument();
    });

    it.each([
      { pin: "", expectEnabled: false },
      { pin: "12345", expectEnabled: false },
      { pin: "123456", expectEnabled: true },
      { pin: "123456789012", expectEnabled: true },
    ])(
      "with PIN of length $pin.length the 確認 button enabled is $expectEnabled",
      ({ pin, expectEnabled }) => {
        render(<PinInput mode="verify" onComplete={vi.fn()} />);

        if (pin) typePin(pin);

        if (expectEnabled) {
          expect(getSubmitButton()).toBeEnabled();
        } else {
          expect(getSubmitButton()).toBeDisabled();
        }
      },
    );

    it("strips non-digit characters silently", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);

      typePin("abc123");

      expect(getInput().value).toBe("123");
      expect(errorLine()).toBeNull();
      expect(screen.queryByText(/只能包含數字/)).not.toBeInTheDocument();
    });

    it("ignores a change that exceeds 12 digits, keeping the previous value", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);

      typePin("12345");
      typePin("1234567890123");

      expect(getInput().value).toBe("12345");
    });

    it("counts digits only, so a 13-character change with one letter is accepted", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);

      typePin("12345678901a2");

      expect(getInput().value).toBe("123456789012");
    });

    it("shows the digit counter, updated as the user types", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      expect(screen.getByText("0/6-12 位")).toBeInTheDocument();

      typePin("1234567");

      expect(screen.getByText("7/6-12 位")).toBeInTheDocument();
      expect(screen.queryByText("0/6-12 位")).not.toBeInTheDocument();
    });

    it("displays external error", () => {
      render(
        <PinInput mode="verify" onComplete={vi.fn()} error="PIN 碼錯誤" />,
      );
      expect(screen.getByText("PIN 碼錯誤")).toBeInTheDocument();
      // Positive companion for the errorLine() negatives above.
      expect(errorLine()?.textContent).toBe("PIN 碼錯誤");
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
      const { rerender } = render(
        <PinInput mode="verify" onComplete={onComplete} />,
      );
      typePin("123456");
      rerender(<PinInput mode="verify" onComplete={onComplete} disabled />);

      // handleSubmit bails out early when disabled, so even a valid PIN is ignored.
      fireEvent.click(getSubmitButton());
      pressEnter();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("keeps the input and button interactive when disabled is omitted (default false)", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      expect(getInput()).not.toBeDisabled();

      typePin("123456");
      expect(getSubmitButton()).not.toBeDisabled();

      fireEvent.click(getSubmitButton());
      expect(onComplete).toHaveBeenCalledWith("123456");
    });

    /** 重新設定 sits OUTSIDE the dimmed wrapper (readable during a lockout), so `pointerEvents: none` misses
     *  it: it needs its own `disabled`, or a locked-out user could wipe the first PIN mid-lockout. */
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

  /** The dim wraps ONLY the interactive cluster (label / hint / input / 確認 / counter): the error line
   *  explaining the lock, and the reset button, stay at full opacity for the whole countdown. */
  describe("disabled dim scope", () => {
    it("dims the input, confirm button and counter while disabled", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} disabled />);

      expect(dimmedAncestor(getInput())).not.toBeNull();
      expect(dimmedAncestor(getSubmitButton())).not.toBeNull();
      expect(dimmedAncestor(screen.getByText("0/6-12 位"))).not.toBeNull();
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
      advanceToConfirmStep();
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

      advanceToConfirmStep();

      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
      expect(getInput().value).toBe("");
    });

    it("calls onComplete only when confirm matches", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      typePin("567890");
      fireEvent.click(getSubmitButton());
      expect(onComplete).not.toHaveBeenCalled();

      typePin("567890");
      fireEvent.click(getSubmitButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("567890");
    });

    it("shows the shared mismatch sentence, not the old wording", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      advanceToConfirmStep();
      typePin("654321");
      fireEvent.click(getSubmitButton());

      expect(errorLine()?.textContent).toBe(PIN_MISMATCH);
      expect(
        screen.queryByText("PIN 碼不一致，請重新輸入"),
      ).not.toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("clears input after mismatch and stays on the confirm step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);

      advanceToConfirmStep();
      typePin("999999");
      fireEvent.click(getSubmitButton());

      expect(getInput().value).toBe("");
      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
    });

    it("clears the mismatch once the user types again", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);

      advanceToConfirmStep();
      typePin("999999");
      fireEvent.click(getSubmitButton());
      expect(screen.getByText(PIN_MISMATCH)).toBeInTheDocument();

      typePin("1");

      expect(screen.queryByText(PIN_MISMATCH)).not.toBeInTheDocument();
    });

    it("shows reset button during confirm step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);

      advanceToConfirmStep();

      const resetBtn = screen.getByText("重新設定");
      expect(resetBtn).toBeInTheDocument();

      fireEvent.click(resetBtn);
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
    });

    it("does not show reset button during enter step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      expect(screen.queryByText("重新設定")).not.toBeInTheDocument();
    });

    it("keeps 確認 disabled in setup mode too, without advancing or erroring", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      typePin("12");

      expect(getSubmitButton()).toBeDisabled();
      fireEvent.click(getSubmitButton());
      pressEnter();
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
      expect(screen.queryByText("再次輸入 PIN 碼確認")).not.toBeInTheDocument();
      expect(errorLine()).toBeNull();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  /** Identically titled cases live in `pwa/tests/component/PinInput.test.tsx`. See the file header,
   *  "Twin contract (#385)". */
  describe("twin contract (#385)", () => {
    it('strips non-digits silently: "12a345" becomes "12345"', () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);

      typePin("12a345");

      expect(getInput()).toHaveValue("12345");
      expect(screen.getByText("5/6-12 位")).toBeInTheDocument();
    });

    it("keeps 確認 disabled and Enter inert at 5 digits", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);

      typePin("12345");

      expect(getSubmitButton()).toBeDisabled();
      pressEnter();
      fireEvent.click(getSubmitButton());
      expect(onComplete).not.toHaveBeenCalled();
      expect(screen.getByText("5/6-12 位")).toBeInTheDocument();
    });

    it("shows the exact mismatch copy when the setup confirm differs", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);

      typePin("123456");
      fireEvent.click(getSubmitButton());
      typePin("654321");
      fireEvent.click(getSubmitButton());

      expect(screen.getByText(PIN_MISMATCH)).toBeInTheDocument();
      expect(getInput()).toHaveValue("");
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("shows the mismatch over the error prop, then the error prop once the user types again", () => {
      render(
        <PinInput mode="setup" onComplete={vi.fn()} error={EXTERNAL_ERROR} />,
      );
      expect(screen.getByText(EXTERNAL_ERROR)).toBeInTheDocument();

      typePin("123456");
      fireEvent.click(getSubmitButton());
      typePin("654321");
      fireEvent.click(getSubmitButton());

      expect(screen.getByText(PIN_MISMATCH)).toBeInTheDocument();
      expect(screen.queryByText(EXTERNAL_ERROR)).not.toBeInTheDocument();

      typePin("1");

      expect(screen.getByText(EXTERNAL_ERROR)).toBeInTheDocument();
      expect(screen.queryByText(PIN_MISMATCH)).not.toBeInTheDocument();
    });
  });

  /** Unmounting before the 0ms refocus tick must cancel the timer. Real clock to settle, fake only to hold
   *  it pending; assertions stay synchronous. See the file header, "Deferred refocus cleanup". */
  describe("deferred refocus cleanup", () => {
    /** Undoes the clearTimeout spy while the FAKE clearTimeout is still on globalThis — restore, then swap
     *  the clock back. See the file header. */
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

      advanceToConfirmStep();

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
