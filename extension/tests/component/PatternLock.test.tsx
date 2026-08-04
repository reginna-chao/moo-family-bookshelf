import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PatternLock } from "@/dialog/PatternLock";
import { dimmedAncestor, dimmedElements } from "./helpers/dimStyle";

// The SVG is 200x200 viewBox, rendered at 200x200 pixels.
// Dots: spacing = 200/3 ~66.67, offset = 33.33
const SPACING = 200 / 3;
const OFFSET = SPACING / 2;

function getDotClientPos(index: number) {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return { clientX: col * SPACING + OFFSET, clientY: row * SPACING + OFFSET };
}

/** Simulate a pattern draw via mouse events, with getBoundingClientRect mocked. */
function simulatePattern(svg: Element, dotIndices: number[]) {
  // Mock getBoundingClientRect so getEventPos computes correct coordinates
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

  if (dotIndices.length === 0) return;

  fireEvent.mouseDown(svg, getDotClientPos(dotIndices[0]));

  for (let i = 1; i < dotIndices.length; i++) {
    fireEvent.mouseMove(svg, getDotClientPos(dotIndices[i]));
  }

  fireEvent.mouseUp(svg);
}

describe("PatternLock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("verify mode", () => {
    it("renders 9 dots", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);
      for (let i = 0; i < 9; i++) {
        expect(screen.getByTestId(`dot-${i}`)).toBeInTheDocument();
      }
    });

    it("shows verify label", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);
      expect(screen.getByText("請繪製解鎖圖形")).toBeInTheDocument();
    });

    it("displays external error", () => {
      render(
        <PatternLock mode="verify" onComplete={vi.fn()} error="圖形錯誤" />,
      );
      expect(screen.getByText("圖形錯誤")).toBeInTheDocument();
    });

    it("has role=application with aria-label", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);
      const svg = screen.getByRole("application");
      expect(svg).toHaveAttribute("aria-label", "圖形鎖");
    });
  });

  describe("setup mode", () => {
    it("shows setup label first", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);
      expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
    });
  });

  describe("minimum dots validation", () => {
    it("shows error when fewer than 4 dots connected", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);
      const svg = screen.getByRole("application");

      simulatePattern(svg, [0, 1, 2]);

      expect(screen.getByText("至少需要連接 4 個點")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("pattern serialization", () => {
    it("serializes pattern as comma-separated indices", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);
      const svg = screen.getByRole("application");

      simulatePattern(svg, [0, 3, 6, 7]);

      expect(onComplete).toHaveBeenCalledWith("0,3,6,7");
    });
  });

  describe("disabled prop", () => {
    it("does not call onComplete when a pattern is drawn while disabled", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} disabled />);
      const svg = screen.getByRole("application");

      // handleStart returns early when disabled, so no dot is ever selected.
      simulatePattern(svg, [0, 3, 6, 7]);

      expect(onComplete).not.toHaveBeenCalled();
    });

    it("still completes a pattern when disabled is omitted (default false)", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);
      const svg = screen.getByRole("application");

      simulatePattern(svg, [0, 1, 4, 7]);

      expect(onComplete).toHaveBeenCalledWith("0,1,4,7");
    });

    /**
     * 重新設定 sits OUTSIDE the dimmed wrapper (so it stays readable during a
     * lockout countdown), which means `pointerEvents: none` does not cover it.
     * It therefore needs its own `disabled` — otherwise a locked-out user could
     * still wipe the first pattern and restart the setup mid-lockout.
     */
    it("marks the setup reset button as disabled while disabled", () => {
      const { rerender } = render(
        <PatternLock mode="setup" onComplete={vi.fn()} />,
      );
      simulatePattern(screen.getByRole("application"), [0, 3, 6, 7]);

      rerender(<PatternLock mode="setup" onComplete={vi.fn()} disabled />);

      expect(screen.getByText("重新設定")).toBeDisabled();
    });

    it("does not return to the enter step when the reset button is clicked while disabled", () => {
      const { rerender } = render(
        <PatternLock mode="setup" onComplete={vi.fn()} />,
      );
      simulatePattern(screen.getByRole("application"), [0, 3, 6, 7]);
      rerender(<PatternLock mode="setup" onComplete={vi.fn()} disabled />);

      fireEvent.click(screen.getByText("重新設定"));

      // Still on the confirm step — the reset never ran.
      expect(screen.getByText("再次繪製圖形確認")).toBeInTheDocument();
      expect(screen.queryByText("設定解鎖圖形")).not.toBeInTheDocument();
    });

    it("keeps the setup reset button enabled and working when disabled is omitted", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);
      simulatePattern(screen.getByRole("application"), [0, 3, 6, 7]);

      expect(screen.getByText("重新設定")).not.toBeDisabled();

      fireEvent.click(screen.getByText("重新設定"));
      expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
    });
  });

  /**
   * The dim wraps ONLY the interactive cluster (label + dot grid). The error
   * line is what explains the lock during a rate-limit countdown, so it — and
   * the reset button — must stay readable at full opacity for the whole wait.
   */
  describe("disabled dim scope", () => {
    it("dims the dot grid while disabled", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} disabled />);

      expect(dimmedAncestor(screen.getByRole("application"))).not.toBeNull();
    });

    it("keeps the error line outside the dimmed cluster while disabled", () => {
      render(
        <PatternLock
          mode="verify"
          onComplete={vi.fn()}
          disabled
          error="圖形錯誤"
        />,
      );

      expect(dimmedAncestor(screen.getByText("圖形錯誤"))).toBeNull();
    });

    it("renders no dimmed wrapper at all when enabled", () => {
      const { container } = render(
        <PatternLock mode="verify" onComplete={vi.fn()} error="圖形錯誤" />,
      );

      expect(dimmedElements(container)).toHaveLength(0);
    });

    it("keeps the reset button outside the dimmed cluster while disabled", () => {
      const { rerender } = render(
        <PatternLock mode="setup" onComplete={vi.fn()} />,
      );
      // Advance to the confirm step so 重新設定 renders, then lock the widget.
      simulatePattern(screen.getByRole("application"), [0, 3, 6, 7]);
      rerender(
        <PatternLock
          mode="setup"
          onComplete={vi.fn()}
          disabled
          error="圖形錯誤"
        />,
      );

      expect(dimmedAncestor(screen.getByText("重新設定"))).toBeNull();
      expect(dimmedAncestor(screen.getByText("圖形錯誤"))).toBeNull();
      // Sanity: the widget the user cannot use IS dimmed.
      expect(dimmedAncestor(screen.getByRole("application"))).not.toBeNull();
    });
  });
});
