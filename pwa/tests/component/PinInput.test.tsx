import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PinInput } from "@/components/PinInput";

const VALID_PIN = "123456";

interface SetupOptions {
  mode?: "setup" | "verify";
  disabled?: boolean;
  withCancel?: boolean;
}

function setup({
  mode = "verify",
  disabled,
  withCancel = false,
}: SetupOptions = {}) {
  const onComplete = vi.fn();
  const onCancel = vi.fn();
  const ui = (isDisabled?: boolean) => (
    <PinInput
      mode={mode}
      onComplete={onComplete}
      disabled={isDisabled}
      onCancel={withCancel ? onCancel : undefined}
    />
  );
  const { rerender } = render(ui(disabled));
  return {
    onComplete,
    onCancel,
    setDisabled: (next: boolean) => rerender(ui(next)),
  };
}

const pinField = () => screen.getByLabelText("PIN 輸入");
const confirmButton = () => screen.getByRole("button", { name: "確認" });
const cancelButton = () => screen.getByRole("button", { name: "取消" });

function typePin(value: string) {
  fireEvent.change(pinField(), { target: { value } });
}

function pressEnter() {
  fireEvent.keyDown(pinField(), { key: "Enter", code: "Enter" });
}

describe("PinInput", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("enabled", () => {
    it("treats the PIN input as enabled when the disabled prop is omitted", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);

      typePin(VALID_PIN);

      expect(pinField()).toBeEnabled();
      expect(confirmButton()).toBeEnabled();

      fireEvent.click(confirmButton());

      expect(onComplete).toHaveBeenCalledWith(VALID_PIN);
    });

    it.each([
      { pin: "", expectEnabled: false },
      { pin: "12345", expectEnabled: false },
      { pin: "123456", expectEnabled: true },
      { pin: "123456789012", expectEnabled: true },
    ])(
      "with PIN of length $pin.length the 確認 button enabled is $expectEnabled",
      ({ pin, expectEnabled }) => {
        setup();

        if (pin) typePin(pin);

        if (expectEnabled) {
          expect(confirmButton()).toBeEnabled();
        } else {
          expect(confirmButton()).toBeDisabled();
        }
      },
    );

    it("submits the PIN when Enter is pressed in verify mode", () => {
      const { onComplete } = setup();

      typePin(VALID_PIN);
      pressEnter();

      expect(onComplete).toHaveBeenCalledWith(VALID_PIN);
    });

    it("advances to the re-entry step in setup mode", () => {
      const { onComplete } = setup({ mode: "setup" });

      typePin(VALID_PIN);
      fireEvent.click(confirmButton());

      expect(screen.getByText("請再次輸入 PIN 碼確認")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("disabled", () => {
    it("disables the PIN field and the 確認 button even with a valid PIN", () => {
      const { setDisabled } = setup();

      typePin(VALID_PIN);
      expect(confirmButton()).toBeEnabled();

      setDisabled(true);

      expect(pinField()).toBeDisabled();
      expect(confirmButton()).toBeDisabled();
    });

    it("does not fire onComplete when Enter is pressed", () => {
      const { onComplete, setDisabled } = setup();

      typePin(VALID_PIN);
      setDisabled(true);
      pressEnter();

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("does not fire onComplete when the 確認 button is clicked", () => {
      const { onComplete, setDisabled } = setup();

      typePin(VALID_PIN);
      setDisabled(true);
      fireEvent.click(confirmButton());

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("does not advance to the re-entry step in setup mode", () => {
      const { setDisabled } = setup({ mode: "setup" });

      typePin(VALID_PIN);
      setDisabled(true);
      pressEnter();

      expect(screen.getByText(/設定 PIN 碼/)).toBeInTheDocument();
      expect(
        screen.queryByText("請再次輸入 PIN 碼確認"),
      ).not.toBeInTheDocument();
    });

    it("keeps 取消 clickable so the user can still leave", () => {
      const { onCancel } = setup({ disabled: true, withCancel: true });

      expect(cancelButton()).toBeEnabled();

      fireEvent.click(cancelButton());

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("restores the entered PIN and confirmation once re-enabled", () => {
      const { onComplete, setDisabled } = setup();

      typePin(VALID_PIN);
      setDisabled(true);
      setDisabled(false);

      expect(pinField()).toBeEnabled();
      expect(pinField()).toHaveValue(VALID_PIN);
      expect(confirmButton()).toBeEnabled();

      fireEvent.click(confirmButton());

      expect(onComplete).toHaveBeenCalledWith(VALID_PIN);
    });
  });

  describe("error announcement", () => {
    // Mirrors the back-off copy LandingPage passes down; the literals are pinned
    // in tests/unit/retryMessage.test.ts.
    const TICKING_ERROR = "嘗試次數過多，請於 45 秒後再試。";
    const STABLE_ERROR = "嘗試次數過多，請稍後再試。";

    it("announces the stable sentence while showing the ticking one", () => {
      render(
        <PinInput
          mode="verify"
          onComplete={vi.fn()}
          error={TICKING_ERROR}
          errorAnnouncement={STABLE_ERROR}
        />,
      );

      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert").textContent).toBe(STABLE_ERROR);
      expect(screen.getByText(TICKING_ERROR)).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    });

    it("announces the error itself when no announcement is supplied", () => {
      render(
        <PinInput mode="verify" onComplete={vi.fn()} error={STABLE_ERROR} />,
      );

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe(STABLE_ERROR);
      expect(alert).not.toHaveAttribute("aria-hidden");
    });

    it("lets a local mismatch replace and announce itself", () => {
      render(
        <PinInput
          mode="setup"
          onComplete={vi.fn()}
          error={TICKING_ERROR}
          errorAnnouncement={STABLE_ERROR}
        />,
      );

      typePin(VALID_PIN);
      fireEvent.click(confirmButton());
      typePin("999999");
      fireEvent.click(confirmButton());

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe("兩次輸入的 PIN 碼不一致，請重新輸入。");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(TICKING_ERROR)).not.toBeInTheDocument();
    });
  });
});
