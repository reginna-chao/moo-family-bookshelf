import { createContext, useContext } from "react";

/**
 * DOM node that overlay/portal UI (e.g. OverflowMenu) should render into.
 *
 * In production the dialog lives inside a Shadow Root, so portals must target a
 * node INSIDE that shadow tree — otherwise the portaled panel escapes to the
 * page's light DOM and loses the scoped stylesheet. mountDialog provides the
 * shadow root as the value. On the standalone dev page (no shadow root) the
 * default `document.body` is used, matching the pre-isolation behaviour.
 */
/**
 * `createPortal` accepts an `Element | DocumentFragment` container. A ShadowRoot
 * is a DocumentFragment (not an Element), so the context is typed as the union.
 */
export type PortalContainer = Element | DocumentFragment;

const PortalContainerContext = createContext<PortalContainer>(
  typeof document !== "undefined"
    ? document.body
    : (null as unknown as PortalContainer),
);

export { PortalContainerContext };

/** Read the current portal container. Defaults to `document.body`. */
export function usePortalContainer(): PortalContainer {
  return useContext(PortalContainerContext);
}
