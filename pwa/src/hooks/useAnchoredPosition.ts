import { useCallback, useState } from "react";

export interface AnchoredPosition {
  /** `position: fixed` top in CSS pixels. */
  top: number;
  /** `position: fixed` left in CSS pixels. */
  left: number;
}

interface ComputeArgs {
  triggerRect: DOMRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Gap between the trigger and the menu panel. */
  gap: number;
  /** Minimum distance to keep from the viewport edges. */
  margin: number;
}

/**
 * Pure positioning math: place the menu below the trigger, right-aligned to it.
 * Flip above when there is not enough room below, then clamp into the viewport.
 */
export function computeAnchoredPosition({
  triggerRect,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  gap,
  margin,
}: ComputeArgs): AnchoredPosition {
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const flipUp = spaceBelow < menuHeight + gap && triggerRect.top > spaceBelow;

  const rawTop = flipUp
    ? triggerRect.top - menuHeight - gap
    : triggerRect.bottom + gap;
  const rawLeft = triggerRect.right - menuWidth;

  const maxLeft = viewportWidth - menuWidth - margin;
  const maxTop = viewportHeight - menuHeight - margin;

  return {
    left: clamp(rawLeft, margin, Math.max(margin, maxLeft)),
    top: clamp(rawTop, margin, Math.max(margin, maxTop)),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

const GAP = 4;
const MARGIN = 8;

/**
 * Tracks a fixed-position anchor for a portaled menu panel. `place` reads the
 * trigger and (optionally measured) panel size, computes a clamped position,
 * and stores it. Returns `null` until the first `place()` call.
 */
export function useAnchoredPosition(): {
  position: AnchoredPosition | null;
  place: (trigger: HTMLElement | null, panel: HTMLElement | null) => void;
  reset: () => void;
} {
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  const place = useCallback(
    (trigger: HTMLElement | null, panel: HTMLElement | null) => {
      if (!trigger) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuWidth = panel?.offsetWidth ?? triggerRect.width;
      const menuHeight = panel?.offsetHeight ?? 0;
      setPosition(
        computeAnchoredPosition({
          triggerRect,
          menuWidth,
          menuHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          gap: GAP,
          margin: MARGIN,
        }),
      );
    },
    [],
  );

  const reset = useCallback(() => setPosition(null), []);

  return { position, place, reset };
}
