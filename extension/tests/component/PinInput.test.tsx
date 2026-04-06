import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PinInput } from "@/dialog/PinInput";

describe("PinInput", () => {
  describe("verify mode", () => {
    it("renders 4 digit inputs by default", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      const pinInputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);
      expect(pinInputs).toHaveLength(4);
    });

    it("shows the verify label", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      expect(screen.getByText("請輸入 PIN 碼")).toBeInTheDocument();
    });

    it("calls onComplete when all digits are entered", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="verify" onComplete={onComplete} />);
      const inputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);

      fireEvent.change(inputs[0], { target: { value: "1" } });
      fireEvent.change(inputs[1], { target: { value: "2" } });
      fireEvent.change(inputs[2], { target: { value: "3" } });
      fireEvent.change(inputs[3], { target: { value: "4" } });

      expect(onComplete).toHaveBeenCalledWith("1234");
    });

    it("renders custom length", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} length={6} />);
      const inputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);
      expect(inputs).toHaveLength(6);
    });

    it("rejects non-digit input", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} />);
      const inputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);
      fireEvent.change(inputs[0], { target: { value: "a" } });
      expect(inputs[0]).toHaveValue("");
    });

    it("displays external error", () => {
      render(<PinInput mode="verify" onComplete={vi.fn()} error="PIN 碼錯誤" />);
      expect(screen.getByText("PIN 碼錯誤")).toBeInTheDocument();
    });
  });

  describe("setup mode", () => {
    it("shows enter label first, then confirm label", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();

      const inputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);
      fireEvent.change(inputs[0], { target: { value: "1" } });
      fireEvent.change(inputs[1], { target: { value: "2" } });
      fireEvent.change(inputs[2], { target: { value: "3" } });
      fireEvent.change(inputs[3], { target: { value: "4" } });

      expect(screen.getByText("再次輸入 PIN 碼確認")).toBeInTheDocument();
    });

    it("calls onComplete only when confirm matches", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);
      const getInputs = () => screen.getAllByLabelText(/PIN 第 \d+ 碼/);

      // Enter first PIN
      let inputs = getInputs();
      fireEvent.change(inputs[0], { target: { value: "5" } });
      fireEvent.change(inputs[1], { target: { value: "6" } });
      fireEvent.change(inputs[2], { target: { value: "7" } });
      fireEvent.change(inputs[3], { target: { value: "8" } });

      // Confirm with same PIN
      inputs = getInputs();
      fireEvent.change(inputs[0], { target: { value: "5" } });
      fireEvent.change(inputs[1], { target: { value: "6" } });
      fireEvent.change(inputs[2], { target: { value: "7" } });
      fireEvent.change(inputs[3], { target: { value: "8" } });

      expect(onComplete).toHaveBeenCalledWith("5678");
    });

    it("shows mismatch error when confirm does not match", () => {
      const onComplete = vi.fn();
      render(<PinInput mode="setup" onComplete={onComplete} />);
      const getInputs = () => screen.getAllByLabelText(/PIN 第 \d+ 碼/);

      // Enter first PIN
      let inputs = getInputs();
      fireEvent.change(inputs[0], { target: { value: "1" } });
      fireEvent.change(inputs[1], { target: { value: "2" } });
      fireEvent.change(inputs[2], { target: { value: "3" } });
      fireEvent.change(inputs[3], { target: { value: "4" } });

      // Enter different confirm PIN
      inputs = getInputs();
      fireEvent.change(inputs[0], { target: { value: "9" } });
      fireEvent.change(inputs[1], { target: { value: "8" } });
      fireEvent.change(inputs[2], { target: { value: "7" } });
      fireEvent.change(inputs[3], { target: { value: "6" } });

      expect(screen.getByText("PIN 碼不一致，請重新輸入")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("shows reset button during confirm step", () => {
      render(<PinInput mode="setup" onComplete={vi.fn()} />);
      const inputs = screen.getAllByLabelText(/PIN 第 \d+ 碼/);

      fireEvent.change(inputs[0], { target: { value: "1" } });
      fireEvent.change(inputs[1], { target: { value: "2" } });
      fireEvent.change(inputs[2], { target: { value: "3" } });
      fireEvent.change(inputs[3], { target: { value: "4" } });

      const resetBtn = screen.getByText("重新設定");
      expect(resetBtn).toBeInTheDocument();

      fireEvent.click(resetBtn);
      expect(screen.getByText("設定 PIN 碼")).toBeInTheDocument();
    });
  });
});
