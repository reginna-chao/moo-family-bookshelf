import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { PatternLock } from "@/dialog/PatternLock";
import { dimmedAncestor, dimmedElements } from "./helpers/dimStyle";
import {
  connectedDotsText,
  drawPattern,
  PATTERN_SVG_SIZE,
  patternConfirmButton,
  patternDotCenter,
  patternGrid,
} from "./helpers/patternGrid";

/**
 * PatternLock: draw-then-confirm submit model, setup double entry, the disabled / dimmed states.
 *
 * Submit model (#385): releasing the pointer (mouseUp / mouseLeave / touchEnd) only ends the stroke;
 * the pattern is submitted by the 確認 button, disabled until 4 dots are connected. Fewer dots show
 * no error line (`.moo-secret-entry__error`); "displays external error" is the positive companion
 * pinning that selector.
 *
 * Twin contract (#385): `extension/src/dialog/PatternLock.tsx` and `pwa/src/components/PatternLock.tsx`
 * are a `必須一致（行為測試）` pair (`.claude/rules/frontend.md` → Extension ↔ PWA twins). The
 * `describe("twin contract (#385)")` block here and its namesake in
 * `pwa/tests/component/PatternLock.test.tsx` carry identically titled cases with the same dots and
 * the same expected strings — edit both or neither. The grids differ (200 viewBox here, 280 there),
 * so each side drives its own `helpers/patternGrid.ts`. The literals are pinned against
 * `shared/src/verifyInput/` in `extension/tests/unit/verifyInputRules.test.ts`.
 */

const PATTERN_MISMATCH = "兩次圖形不一致，請重新繪製。";
const EXTERNAL_ERROR = "伺服器錯誤";

function errorLine(): Element | null {
  return document.querySelector(".moo-secret-entry__error");
}

/** Stub the grid's box 1:1 to the viewBox, for cases that fire raw pointer events. */
function stubGridRect(): void {
  vi.spyOn(patternGrid(), "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: PATTERN_SVG_SIZE,
    bottom: PATTERN_SVG_SIZE,
    width: PATTERN_SVG_SIZE,
    height: PATTERN_SVG_SIZE,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/** Draw and confirm a first pattern in setup mode, reaching the confirm step where 重新設定 renders. */
function advanceToConfirmStep(): void {
  drawPattern([0, 3, 6, 7]);
  fireEvent.click(patternConfirmButton());
}

describe("PatternLock", () => {
  afterEach(() => {
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
      // Positive companion for the errorLine() negatives below.
      expect(errorLine()?.textContent).toBe("圖形錯誤");
    });

    it("has role=application with aria-label", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);
      expect(patternGrid()).toHaveAttribute("aria-label", "圖形鎖");
    });

    it("renders a 確認 button, disabled before any dot is drawn", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);
      expect(patternConfirmButton()).toBeDisabled();
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
    });

    it("highlights the dots of the drawn pattern", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);

      drawPattern([0, 3, 6, 7]);

      expect(screen.getByTestId("dot-0")).toHaveAttribute("fill", "#2563eb");
      expect(screen.getByTestId("dot-1")).toHaveAttribute("fill", "#cbd5e1");
    });
  });

  describe("minimum dots", () => {
    it("keeps 確認 disabled and shows no error when fewer than 4 dots connected", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 1, 2]);

      expect(connectedDotsText()).toBe("已連接 3 個點（最少 4 個）");
      expect(patternConfirmButton()).toBeDisabled();
      fireEvent.click(patternConfirmButton());
      expect(onComplete).not.toHaveBeenCalled();
      expect(errorLine()).toBeNull();
      expect(screen.queryByText("至少需要連接 4 個點")).not.toBeInTheDocument();
    });

    it.each([
      { dots: [0], expectEnabled: false },
      { dots: [0, 1, 2], expectEnabled: false },
      { dots: [0, 1, 2, 5], expectEnabled: true },
      { dots: [0, 1, 2, 5, 8], expectEnabled: true },
    ])(
      "with $dots.length connected dots the 確認 button enabled is $expectEnabled",
      ({ dots, expectEnabled }) => {
        render(<PatternLock mode="verify" onComplete={vi.fn()} />);

        drawPattern(dots);

        if (expectEnabled) {
          expect(patternConfirmButton()).toBeEnabled();
        } else {
          expect(patternConfirmButton()).toBeDisabled();
        }
      },
    );
  });

  describe("stroke end", () => {
    it("keeps the drawn dots after release instead of resetting them", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 3, 6, 7]);

      expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();
    });

    it.each([
      ["mouseLeave", (grid: Element) => fireEvent.mouseLeave(grid)],
      ["touchEnd", (grid: Element) => fireEvent.touchEnd(grid)],
    ])("ends the stroke on %s without submitting", (_label, endStroke) => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);
      stubGridRect();
      const grid = patternGrid();

      fireEvent.mouseDown(grid, patternDotCenter(0));
      for (const dot of [1, 2, 5]) {
        fireEvent.mouseMove(grid, patternDotCenter(dot));
      }
      endStroke(grid);
      // The stroke is over, so passing over another dot adds nothing.
      fireEvent.mouseMove(grid, patternDotCenter(8));

      expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();
      expect(patternConfirmButton()).toBeEnabled();
    });

    it("starts a fresh selection when a new stroke begins", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} />);

      drawPattern([0, 3, 6, 7]);
      drawPattern([4, 5]);

      expect(connectedDotsText()).toBe("已連接 2 個點（最少 4 個）");
    });
  });

  describe("pattern serialization", () => {
    it("serializes pattern as comma-separated indices once 確認 is clicked", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 3, 6, 7]);
      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("0,3,6,7");
    });
  });

  describe("setup mode", () => {
    it("shows setup label first", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);
      expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
    });

    it("advances to the re-draw step on the first 確認 and clears the selection", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="setup" onComplete={onComplete} />);

      advanceToConfirmStep();

      expect(screen.getByText("再次繪製圖形確認")).toBeInTheDocument();
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("calls onComplete when the re-drawn pattern matches", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="setup" onComplete={onComplete} />);

      advanceToConfirmStep();
      drawPattern([0, 3, 6, 7]);
      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("0,3,6,7");
    });

    it("stays on the re-draw step with a cleared selection after a mismatch", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);

      advanceToConfirmStep();
      drawPattern([0, 1, 2, 5]);
      fireEvent.click(patternConfirmButton());

      expect(errorLine()?.textContent).toBe(PATTERN_MISMATCH);
      expect(screen.getByText("再次繪製圖形確認")).toBeInTheDocument();
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
    });

    it("returns to the enter step and drops the mismatch on 重新設定", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);

      advanceToConfirmStep();
      drawPattern([0, 1, 2, 5]);
      fireEvent.click(patternConfirmButton());
      fireEvent.click(screen.getByText("重新設定"));

      expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
      expect(screen.queryByText(PATTERN_MISMATCH)).not.toBeInTheDocument();
    });
  });

  describe("disabled prop", () => {
    it("ignores the drawing gesture and keeps 確認 disabled while disabled", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} disabled />);

      // handleStart returns early when disabled, so no dot is ever selected.
      drawPattern([0, 3, 6, 7]);
      fireEvent.click(patternConfirmButton());

      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(patternConfirmButton()).toBeDisabled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("does not submit a pattern drawn before the widget was disabled", () => {
      const onComplete = vi.fn();
      const { rerender } = render(
        <PatternLock mode="verify" onComplete={onComplete} />,
      );
      drawPattern([0, 3, 6, 7]);
      expect(patternConfirmButton()).toBeEnabled();

      rerender(<PatternLock mode="verify" onComplete={onComplete} disabled />);
      fireEvent.click(patternConfirmButton());

      expect(patternConfirmButton()).toBeDisabled();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("still completes a pattern when disabled is omitted (default false)", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 1, 4, 7]);
      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledWith("0,1,4,7");
    });

    /** 重新設定 sits OUTSIDE the dimmed wrapper (readable during a lockout), so `pointerEvents: none` misses
     *  it: it needs its own `disabled`, or a locked-out user could wipe the first pattern mid-lockout. */
    it("marks the setup reset button as disabled while disabled", () => {
      const { rerender } = render(
        <PatternLock mode="setup" onComplete={vi.fn()} />,
      );
      advanceToConfirmStep();

      rerender(<PatternLock mode="setup" onComplete={vi.fn()} disabled />);

      expect(screen.getByText("重新設定")).toBeDisabled();
    });

    it("does not return to the enter step when the reset button is clicked while disabled", () => {
      const { rerender } = render(
        <PatternLock mode="setup" onComplete={vi.fn()} />,
      );
      advanceToConfirmStep();
      rerender(<PatternLock mode="setup" onComplete={vi.fn()} disabled />);

      fireEvent.click(screen.getByText("重新設定"));

      // Still on the confirm step — the reset never ran.
      expect(screen.getByText("再次繪製圖形確認")).toBeInTheDocument();
      expect(screen.queryByText("設定解鎖圖形")).not.toBeInTheDocument();
    });

    it("keeps the setup reset button enabled and working when disabled is omitted", () => {
      render(<PatternLock mode="setup" onComplete={vi.fn()} />);
      advanceToConfirmStep();

      expect(screen.getByText("重新設定")).not.toBeDisabled();

      fireEvent.click(screen.getByText("重新設定"));
      expect(screen.getByText("設定解鎖圖形")).toBeInTheDocument();
    });
  });

  /** The dim wraps ONLY the interactive cluster (label / dot grid / counter / 確認): the error line
   *  explaining the lock, and the reset button, stay at full opacity for the whole countdown. */
  describe("disabled dim scope", () => {
    it("dims the dot grid, the counter and 確認 while disabled", () => {
      render(<PatternLock mode="verify" onComplete={vi.fn()} disabled />);

      expect(dimmedAncestor(patternGrid())).not.toBeNull();
      expect(dimmedAncestor(screen.getByText(/已連接/))).not.toBeNull();
      expect(dimmedAncestor(patternConfirmButton())).not.toBeNull();
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
      advanceToConfirmStep();
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
      expect(dimmedAncestor(patternGrid())).not.toBeNull();
    });
  });

  /** Identically titled cases live in `pwa/tests/component/PatternLock.test.tsx`. See the file
   *  header, "Twin contract (#385)". */
  describe("twin contract (#385)", () => {
    it("keeps 確認 disabled with 3 dots and never calls onComplete", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 1, 2]);

      expect(connectedDotsText()).toBe("已連接 3 個點（最少 4 個）");
      expect(patternConfirmButton()).toBeDisabled();
      fireEvent.click(patternConfirmButton());
      expect(onComplete).not.toHaveBeenCalled();
    });

    it('does not submit on release; 確認 submits "0,1,2,5"', () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 1, 2, 5]);

      expect(connectedDotsText()).toBe("已連接 4 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();

      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("0,1,2,5");
    });

    it("clears the drawing after a verify submit so 確認 cannot resend it", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="verify" onComplete={onComplete} />);

      drawPattern([0, 1, 2, 5]);
      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith("0,1,2,5");
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(patternConfirmButton()).toBeDisabled();

      fireEvent.click(patternConfirmButton());

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("shows the exact mismatch copy when the setup redraw differs", () => {
      const onComplete = vi.fn();
      render(<PatternLock mode="setup" onComplete={onComplete} />);

      drawPattern([0, 1, 2, 5]);
      fireEvent.click(patternConfirmButton());
      drawPattern([3, 4, 5, 8]);
      fireEvent.click(patternConfirmButton());

      expect(screen.getByText(PATTERN_MISMATCH)).toBeInTheDocument();
      expect(connectedDotsText()).toBe("已連接 0 個點（最少 4 個）");
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("shows the mismatch over the error prop, then the error prop once a new stroke starts", () => {
      render(
        <PatternLock
          mode="setup"
          onComplete={vi.fn()}
          error={EXTERNAL_ERROR}
        />,
      );
      expect(screen.getByText(EXTERNAL_ERROR)).toBeInTheDocument();

      drawPattern([0, 1, 2, 5]);
      fireEvent.click(patternConfirmButton());
      drawPattern([3, 4, 5, 8]);
      fireEvent.click(patternConfirmButton());

      expect(screen.getByText(PATTERN_MISMATCH)).toBeInTheDocument();
      expect(screen.queryByText(EXTERNAL_ERROR)).not.toBeInTheDocument();

      drawPattern([0]);

      expect(screen.getByText(EXTERNAL_ERROR)).toBeInTheDocument();
      expect(screen.queryByText(PATTERN_MISMATCH)).not.toBeInTheDocument();
    });
  });
});
