import { useState, useRef, useCallback, useEffect } from "react";
import { ErrorAlert } from "./ErrorAlert";

interface PatternLockProps {
  onComplete: (pattern: string) => void;
  mode: "setup" | "verify";
  error?: string;
  /** Stable sentence announced to assistive tech in place of `error` when the
   *  latter ticks (e.g. a back-off countdown). Defaults to `error`. */
  errorAnnouncement?: string;
  onCancel?: () => void;
  /** When true, block confirmation and drawing, and dim the grid (e.g. while a
   *  back-off countdown is running or a submit is in flight). Cancel stays
   *  available. Defaults to false. */
  disabled?: boolean;
}

const GRID_SIZE = 3;
const DOT_COUNT = GRID_SIZE * GRID_SIZE;
const MIN_DOTS = 4;

/** Grid layout: 0-1-2 / 3-4-5 / 6-7-8 */
function dotPosition(
  index: number,
  cellSize: number,
  padding: number,
): { cx: number; cy: number } {
  const col = index % GRID_SIZE;
  const row = Math.floor(index / GRID_SIZE);
  return {
    cx: padding + col * cellSize + cellSize / 2,
    cy: padding + row * cellSize + cellSize / 2,
  };
}

export function PatternLock({
  onComplete,
  mode,
  error,
  errorAnnouncement,
  onCancel,
  disabled = false,
}: PatternLockProps) {
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmPattern, setConfirmPattern] = useState("");
  const [isConfirming, setIsConfirming] = useState(false);
  const [mismatchError, setMismatchError] = useState("");
  const [isDrawing, setIsDrawing] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const svgRef = useRef<SVGSVGElement>(null);

  const cellSize = 80;
  const padding = 20;
  const svgSize = cellSize * GRID_SIZE + padding * 2;

  const getEventPos = useCallback(
    (
      e: React.TouchEvent | React.MouseEvent | TouchEvent | MouseEvent,
    ): { x: number; y: number } | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const clientX =
        "touches" in e
          ? (e.touches[0]?.clientX ?? 0)
          : (e as MouseEvent).clientX;
      const clientY =
        "touches" in e
          ? (e.touches[0]?.clientY ?? 0)
          : (e as MouseEvent).clientY;
      return {
        x: ((clientX - rect.left) / rect.width) * svgSize,
        y: ((clientY - rect.top) / rect.height) * svgSize,
      };
    },
    [svgSize],
  );

  const hitTest = useCallback(
    (pos: { x: number; y: number }): number | null => {
      const hitRadius = cellSize * 0.4;
      for (let i = 0; i < DOT_COUNT; i++) {
        const { cx, cy } = dotPosition(i, cellSize, padding);
        const dx = pos.x - cx;
        const dy = pos.y - cy;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) return i;
      }
      return null;
    },
    [cellSize, padding],
  );

  const handleStart = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setMismatchError("");
      setSelected([]);
      setIsDrawing(true);
      const pos = getEventPos(e);
      if (!pos) return;
      setCursorPos(pos);
      const dot = hitTest(pos);
      if (dot !== null) setSelected([dot]);
    },
    [disabled, getEventPos, hitTest],
  );

  const handleMove = useCallback(
    (e: TouchEvent | MouseEvent) => {
      if (!isDrawing) return;
      e.preventDefault();
      const pos = getEventPos(e);
      if (!pos) return;
      setCursorPos(pos);
      const dot = hitTest(pos);
      if (dot !== null) {
        setSelected((prev) => (prev.includes(dot) ? prev : [...prev, dot]));
      }
    },
    [isDrawing, getEventPos, hitTest],
  );

  const handleEnd = useCallback(() => {
    setIsDrawing(false);
    setCursorPos(null);
  }, []);

  // Attach move/end listeners to window for better UX
  useEffect(() => {
    if (!isDrawing) return;
    const onMove = (e: TouchEvent | MouseEvent) => handleMove(e);
    const onEnd = () => handleEnd();
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchend", onEnd);
    window.addEventListener("mouseup", onEnd);
    return () => {
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("mouseup", onEnd);
    };
  }, [isDrawing, handleMove, handleEnd]);

  const handleConfirm = useCallback(() => {
    if (disabled || selected.length < MIN_DOTS) return;
    const pattern = selected.join(",");

    if (mode === "verify") {
      onComplete(pattern);
      return;
    }

    if (!isConfirming) {
      setConfirmPattern(pattern);
      setIsConfirming(true);
      setSelected([]);
      return;
    }

    if (pattern === confirmPattern) {
      onComplete(pattern);
    } else {
      setMismatchError("兩次圖形不一致，請重新繪製。");
      setSelected([]);
    }
  }, [disabled, selected, mode, isConfirming, confirmPattern, onComplete]);

  const title =
    mode === "verify"
      ? "請繪製圖形驗證"
      : isConfirming
        ? "請再次繪製圖形確認"
        : "設定圖形驗證（至少連接 4 個點）";

  const displayError = mismatchError || error;
  // A local mismatch is static copy — it announces itself.
  const displayAnnouncement = mismatchError ? undefined : errorAnnouncement;
  const gridClass = disabled
    ? "opacity-50 pointer-events-none"
    : "cursor-pointer";

  // Build line segments for connected dots
  const lineSegments: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> = [];
  for (let i = 1; i < selected.length; i++) {
    const from = dotPosition(selected[i - 1], cellSize, padding);
    const to = dotPosition(selected[i], cellSize, padding);
    lineSegments.push({ x1: from.cx, y1: from.cy, x2: to.cx, y2: to.cy });
  }

  // Trailing line to cursor
  if (isDrawing && cursorPos && selected.length > 0) {
    const last = dotPosition(selected[selected.length - 1], cellSize, padding);
    lineSegments.push({
      x1: last.cx,
      y1: last.cy,
      x2: cursorPos.x,
      y2: cursorPos.y,
    });
  }

  return (
    <div className="flex flex-col items-center w-full max-w-xs mx-auto">
      <h2 className="text-lg font-bold text-gray-900 mb-4">{title}</h2>

      <ErrorAlert
        message={displayError ?? ""}
        announcement={displayAnnouncement}
        className="mb-3"
      />

      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        className={`w-full max-w-[280px] aspect-square touch-none select-none mb-4 ${gridClass}`}
        onMouseDown={handleStart}
        onTouchStart={handleStart}
        aria-label="圖形鎖定"
        aria-disabled={disabled || undefined}
      >
        {/* Lines */}
        {lineSegments.map((seg, i) => (
          <line
            key={i}
            x1={seg.x1}
            y1={seg.y1}
            x2={seg.x2}
            y2={seg.y2}
            stroke="#3B82F6"
            strokeWidth={4}
            strokeLinecap="round"
          />
        ))}

        {/* Dots */}
        {Array.from({ length: DOT_COUNT }, (_, i) => {
          const { cx, cy } = dotPosition(i, cellSize, padding);
          const isActive = selected.includes(i);
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={isActive ? 14 : 10}
              fill={isActive ? "#3B82F6" : "#D1D5DB"}
              stroke={isActive ? "#2563EB" : "transparent"}
              strokeWidth={2}
            />
          );
        })}
      </svg>

      <p className="text-xs text-gray-400 mb-3">
        已連接 {selected.length} 個點（最少 {MIN_DOTS} 個）
      </p>

      <button
        type="button"
        onClick={handleConfirm}
        disabled={disabled || selected.length < MIN_DOTS}
        className="w-full bg-blue-600 text-white rounded-lg py-3 font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        確認
      </button>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          取消
        </button>
      )}
    </div>
  );
}
