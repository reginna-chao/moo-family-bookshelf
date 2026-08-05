/**
 * DOM probes for the "disabled dim" presentation contract.
 *
 * `PinInput` / `PatternLock` dim only their INTERACTIVE cluster while
 * `disabled` (inline `opacity: 0.5` + `pointerEvents: none`). The error line —
 * during a rate-limit countdown the only text explaining why input is locked —
 * and the reset button deliberately sit OUTSIDE that wrapper at full opacity.
 *
 * jsdom applies no stylesheet, so the inline style is the contract. Keep the
 * value in sync with the wrapper style in `src/dialog/PinInput.tsx` and
 * `src/dialog/PatternLock.tsx`.
 */
export const DIM_OPACITY = "0.5";

function inlineOpacity(node: Element): string | undefined {
  return (node as Partial<ElementCSSInlineStyle>).style?.opacity;
}

/** Nearest ancestor (or the element itself) carrying the disabled dim. */
export function dimmedAncestor(el: Element | null): Element | null {
  let node: Element | null = el;
  while (node) {
    if (inlineOpacity(node) === DIM_OPACITY) return node;
    node = node.parentElement;
  }
  return null;
}

/** Every element under `root` carrying the disabled dim. */
export function dimmedElements(root: Element): Element[] {
  return Array.from(root.querySelectorAll("*")).filter(
    (el) => inlineOpacity(el) === DIM_OPACITY,
  );
}
