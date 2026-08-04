import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PatternLock } from "@/components/PatternLock";
import {
  connectedDotsText,
  drawPattern,
  patternGrid,
  stubPatternGridRect,
} from "./helpers/patternGrid";

/** A valid (>= 4 dots) pattern: top row then the middle-right dot. */
const VALID_PATTERN = [0, 1, 2, 5];
const VALID_PATTERN_SECRET = "0,1,2,5";

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
    <PatternLock
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

const confirmButton = () => screen.getByRole("button", { name: "確認" });
const cancelButton = () => screen.getByRole("button", { name: "取消" });

describe("PatternLock", () => {
  let restoreRect: () => void;

  beforeEach(() => {
    restoreRect = stubPatternGridRect();
  });

  afterEach(() => {
    restoreRect();
    vi.clearAllMocks();
  });

  describe("enabled", () => {
    it("records the drawn dots and submits the pattern in verify mode", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern(VALID_PATTERN);

      expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
      expect(patternGrid()).not.toHaveAttribute("aria-disabled");
      expect(confirmButton()).toBeEnabled();

      fireEvent.click(confirmButton());

      expect(onComplete).toHaveBeenCalledWith(VALID_PATTERN_SECRET);
    });

    it.each([
      { dots: [0], expectEnabled: false },
      { dots: [0, 1, 2], expectEnabled: false },
      { dots: [0, 1, 2, 5], expectEnabled: true },
      { dots: [0, 1, 2, 5, 8], expectEnabled: true },
    ])(
      "with $dots.length connected dots the 確認 button enabled is $expectEnabled",
      ({ dots, expectEnabled }) => {
        setup();

        drawPattern(dots);

        if (expectEnabled) {
          expect(confirmButton()).toBeEnabled();
        } else {
          expect(confirmButton()).toBeDisabled();
        }
      },
    );

    it("advances to the re-draw step in setup mode", () => {
      const { onComplete } = setup({ mode: "setup" });

      drawPattern(VALID_PATTERN);
      fireEvent.click(confirmButton());

      expect(screen.getByText("請再次繪製圖形確認")).toBeInTheDocument();
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("disabled", () => {
    it("ignores the drawing gesture so no dot is selected", () => {
      const { onComplete } = setup({ disabled: true });

      drawPattern(VALID_PATTERN);

      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(confirmButton()).toBeDisabled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("marks the grid aria-disabled and blocks pointer interaction", () => {
      const { setDisabled } = setup();

      setDisabled(true);

      const grid = patternGrid();
      expect(grid).toHaveAttribute("aria-disabled", "true");
      expect(grid).toHaveClass("opacity-50", "pointer-events-none");
    });

    it("does not fire onComplete for a pattern drawn before disabling", () => {
      const { onComplete, setDisabled } = setup();

      drawPattern(VALID_PATTERN);
      expect(confirmButton()).toBeEnabled();

      setDisabled(true);

      expect(confirmButton()).toBeDisabled();

      fireEvent.click(confirmButton());

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("keeps an already drawn pattern intact when a gesture is attempted", () => {
      const { setDisabled } = setup();

      drawPattern(VALID_PATTERN);
      setDisabled(true);

      drawPattern([3, 4]);

      expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
    });

    it("does not advance to the re-draw step in setup mode", () => {
      const { setDisabled } = setup({ mode: "setup" });

      drawPattern(VALID_PATTERN);
      setDisabled(true);
      fireEvent.click(confirmButton());

      expect(screen.getByText(/設定圖形驗證/)).toBeInTheDocument();
      expect(screen.queryByText("請再次繪製圖形確認")).not.toBeInTheDocument();
    });

    it("keeps 取消 clickable so the user can still leave", () => {
      const { onCancel } = setup({ disabled: true, withCancel: true });

      expect(cancelButton()).toBeEnabled();

      fireEvent.click(cancelButton());

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("restores drawing and confirmation once re-enabled", () => {
      const { onComplete, setDisabled } = setup({ disabled: true });

      drawPattern(VALID_PATTERN);
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");

      setDisabled(false);
      drawPattern(VALID_PATTERN);

      expect(patternGrid()).not.toHaveAttribute("aria-disabled");
      expect(confirmButton()).toBeEnabled();

      fireEvent.click(confirmButton());

      expect(onComplete).toHaveBeenCalledWith(VALID_PATTERN_SECRET);
    });
  });

  describe("error announcement", () => {
    // Mirrors the back-off copy LandingPage passes down; the literals are pinned
    // in tests/unit/retryMessage.test.ts.
    const TICKING_ERROR = "嘗試次數過多，請於 45 秒後再試。";
    const STABLE_ERROR = "嘗試次數過多，請稍後再試。";

    it("announces the stable sentence while showing the ticking one", () => {
      render(
        <PatternLock
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
        <PatternLock mode="verify" onComplete={vi.fn()} error={STABLE_ERROR} />,
      );

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe(STABLE_ERROR);
      expect(alert).not.toHaveAttribute("aria-hidden");
    });

    it("lets a local mismatch replace and announce itself", () => {
      render(
        <PatternLock
          mode="setup"
          onComplete={vi.fn()}
          error={TICKING_ERROR}
          errorAnnouncement={STABLE_ERROR}
        />,
      );

      drawPattern(VALID_PATTERN);
      fireEvent.click(confirmButton());
      drawPattern([3, 4, 5, 8]);
      fireEvent.click(confirmButton());

      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe("兩次圖形不一致，請重新繪製。");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(TICKING_ERROR)).not.toBeInTheDocument();
    });
  });
});
