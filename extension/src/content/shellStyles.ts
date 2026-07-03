/**
 * Bootstrap stylesheet for the content-script-injected dialog shell.
 *
 * This is a TINY, self-contained stylesheet — NOT the full scoped `styles.css`.
 * It is injected into the dialog's shadow root the instant the shadow root is
 * created (see `toggleDialog` in `index.ts`), BEFORE the backdrop/dialog are
 * appended, so the shell renders styled immediately. The full scoped stylesheet
 * is injected LATER by `mountDialog` (via a dynamic import of styles.css); if
 * these structural rules lived only there, the shell would flash unstyled.
 *
 * Scope discipline: only the STATIC structural properties of the four shell
 * elements live here. Every property that `applyDialogLayout` /
 * `applyBackdropLayout` set per-breakpoint (position/size/border-radius/height)
 * and the close-icon `display` toggle stay JS-driven as inline styles so a
 * static rule never fights the dynamic inline value. Inline styles win the
 * cascade, but leaving a stale static value here would be confusing, so those
 * dynamic properties are intentionally OMITTED from these rules.
 *
 * NOTE: this module must stay import-free (no `styles.css`, no shared modules)
 * so it can be bundled into the content-script IIFE without pulling the dialog
 * bundle or the full stylesheet into the content bundle.
 */

/** Marker attribute so the shell stylesheet is never injected twice into a root. */
export const SHELL_STYLE_MARKER = "data-moo-shell-styles";

/**
 * Static structural rules for the four shell elements. Class names are
 * `moo-shell-*` to sit clearly apart from the dialog's `moo-*` scoped classes.
 */
export const SHELL_BOOTSTRAP_CSS = `
.moo-shell-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.4);
}
.moo-shell-dialog {
  position: fixed;
  z-index: 100000;
  background: white;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 200px;
}
.moo-shell-mount {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.moo-shell-close {
  position: absolute;
  top: 2px;
  right: 4px;
  z-index: 1;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}
`;
