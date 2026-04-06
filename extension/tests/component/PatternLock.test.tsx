import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PatternLock } from "@/dialog/PatternLock";

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
    left: 0, top: 0, right: 200, bottom: 200,
    width: 200, height: 200, x: 0, y: 0,
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
      render(<PatternLock mode="verify" onComplete={vi.fn()} error="圖形錯誤" />);
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
});
