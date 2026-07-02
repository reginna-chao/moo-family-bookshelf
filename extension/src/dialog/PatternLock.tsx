import React, { useState, useRef, useCallback, useEffect } from "react";

export interface PatternLockProps {
  onComplete: (pattern: string) => void;
  mode: "setup" | "verify";
  error?: string;
}

const GRID_SIZE = 3;
const DOT_COUNT = GRID_SIZE * GRID_SIZE;
const MIN_DOTS = 4;
const CANVAS_SIZE = 200;
const DOT_RADIUS = 12;
const DOT_SPACING = CANVAS_SIZE / GRID_SIZE;
const DOT_OFFSET = DOT_SPACING / 2;

type SetupStep = "enter" | "confirm";

function getDotCenter(index: number): { x: number; y: number } {
  const col = index % GRID_SIZE;
  const row = Math.floor(index / GRID_SIZE);
  return { x: col * DOT_SPACING + DOT_OFFSET, y: row * DOT_SPACING + DOT_OFFSET };
}

function getIndexFromPosition(x: number, y: number): number | null {
  for (let i = 0; i < DOT_COUNT; i++) {
    const center = getDotCenter(i);
    const dist = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2);
    if (dist <= DOT_RADIUS * 1.5) return i;
  }
  return null;
}

export function PatternLock({ onComplete, mode, error }: PatternLockProps) {
  const [selected, setSelected] = useState<number[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [setupStep, setSetupStep] = useState<SetupStep>("enter");
  const [firstPattern, setFirstPattern] = useState("");
  const [mismatchError, setMismatchError] = useState("");
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const reset = useCallback(() => {
    setSelected([]);
    setDrawing(false);
    setMousePos(null);
  }, []);

  const getEventPos = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * CANVAS_SIZE,
      y: ((clientY - rect.top) / rect.height) * CANVAS_SIZE,
    };
  }, []);

  const handleStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault();
      const pos = getEventPos(e);
      const idx = getIndexFromPosition(pos.x, pos.y);
      if (idx === null) return;
      setDrawing(true);
      setSelected([idx]);
      setMismatchError("");
      setMousePos(pos);
    },
    [getEventPos],
  );

  const handleMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!drawing) return;
      e.preventDefault();
      const pos = getEventPos(e);
      setMousePos(pos);
      const idx = getIndexFromPosition(pos.x, pos.y);
      if (idx === null || selected.includes(idx)) return;
      setSelected((prev) => [...prev, idx]);
    },
    [drawing, selected, getEventPos],
  );

  const finishPattern = useCallback(
    (pattern: number[]) => {
      const serialized = pattern.join(",");

      if (pattern.length < MIN_DOTS) {
        setMismatchError(`至少需要連接 ${MIN_DOTS} 個點`);
        reset();
        return;
      }

      if (mode === "verify") {
        onComplete(serialized);
        reset();
        return;
      }

      if (setupStep === "enter") {
        setFirstPattern(serialized);
        setSetupStep("confirm");
        reset();
        return;
      }

      if (serialized === firstPattern) {
        onComplete(serialized);
      } else {
        setMismatchError("圖形不一致，請重新繪製");
      }
      reset();
    },
    [mode, setupStep, firstPattern, onComplete, reset],
  );

  const handleEnd = useCallback(() => {
    if (!drawing) return;
    setDrawing(false);
    setMousePos(null);
    finishPattern(selected);
  }, [drawing, selected, finishPattern]);

  // Prevent scrolling on touch devices while drawing
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const prevent = (e: TouchEvent) => { if (drawing) e.preventDefault(); };
    svg.addEventListener("touchmove", prevent, { passive: false });
    return () => svg.removeEventListener("touchmove", prevent);
  }, [drawing]);

  const displayError = error ?? mismatchError;
  const label =
    mode === "verify"
      ? "請繪製解鎖圖形"
      : setupStep === "enter"
        ? "設定解鎖圖形"
        : "再次繪製圖形確認";

  return (
    <div className="moo-secret-entry">
      <div className="moo-secret-entry__label">{label}</div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}
        width={CANVAS_SIZE}
        height={CANVAS_SIZE}
        className="moo-pattern-lock__svg"
        onMouseDown={handleStart}
        onMouseMove={handleMove}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onTouchStart={handleStart}
        onTouchMove={handleMove}
        onTouchEnd={handleEnd}
        role="application"
        aria-label="圖形鎖"
      >
        {/* Lines between selected dots */}
        {selected.map((dotIdx, i) => {
          if (i === 0) return null;
          const prev = getDotCenter(selected[i - 1]);
          const curr = getDotCenter(dotIdx);
          return (
            <line
              key={`line-${i}`}
              x1={prev.x} y1={prev.y} x2={curr.x} y2={curr.y}
              stroke="#2563eb" strokeWidth={3} strokeLinecap="round"
            />
          );
        })}
        {/* Trailing line from last dot to mouse */}
        {drawing && mousePos && selected.length > 0 && (
          <line
            x1={getDotCenter(selected[selected.length - 1]).x}
            y1={getDotCenter(selected[selected.length - 1]).y}
            x2={mousePos.x} y2={mousePos.y}
            stroke="#93c5fd" strokeWidth={2} strokeLinecap="round"
          />
        )}
        {/* Dots */}
        {Array.from({ length: DOT_COUNT }, (_, i) => {
          const { x, y } = getDotCenter(i);
          const isActive = selected.includes(i);
          return (
            <circle
              key={`dot-${i}`}
              cx={x} cy={y}
              r={isActive ? DOT_RADIUS : DOT_RADIUS * 0.6}
              fill={isActive ? "#2563eb" : "#cbd5e1"}
              stroke={isActive ? "#1d4ed8" : "none"}
              strokeWidth={2}
              data-testid={`dot-${i}`}
            />
          );
        })}
      </svg>
      {displayError && <div className="moo-secret-entry__error">{displayError}</div>}
      {mode === "setup" && setupStep === "confirm" && (
        <button
          onClick={() => {
            setSetupStep("enter");
            setFirstPattern("");
            reset();
            setMismatchError("");
          }}
          className="moo-secret-entry__reset"
        >
          重新設定
        </button>
      )}
    </div>
  );
}
