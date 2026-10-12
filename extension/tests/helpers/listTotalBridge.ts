import { ATTR_LIBRARY_IDS, ATTR_LIST_TOTAL } from "@/content/fiber-data";

/**
 * What the stub publishes on each `moo-request-fiber-data`:
 * - a number: that total, every time;
 * - `"cards"`: the `.library-item` count at the moment of the request (what the
 *   real bridge reports once every page has rendered — borrowed-in cards count);
 * - a function: its return value (`null` removes the attribute, like the real
 *   bridge when it cannot read the host).
 */
export type ListTotalSource = number | "cards" | (() => string | null);

/**
 * Mimics the list-total half of the main-world fiber bridge
 * (`src/content/fiber-bridge.ts` → `publishListTotal`): on every
 * `moo-request-fiber-data` it writes `data-moo-list-total` onto `<html>`. It does
 * NOT dispatch `moo-fiber-data` — pair it with a stamping stub for that, or let
 * `requestFiberData` reach its timeout. Returns a cleanup that removes the
 * listener and the attribute.
 */
export function installListTotalPublisher(source: ListTotalSource): () => void {
  const root = document.documentElement;
  const handler = () => {
    let value: string | null;
    if (source === "cards") {
      value = String(document.querySelectorAll(".library-item").length);
    } else if (typeof source === "number") {
      value = String(source);
    } else {
      value = source();
    }
    if (value === null) root.removeAttribute(ATTR_LIST_TOTAL);
    else root.setAttribute(ATTR_LIST_TOTAL, value);
  };
  document.addEventListener("moo-request-fiber-data", handler);
  return () => {
    document.removeEventListener("moo-request-fiber-data", handler);
    root.removeAttribute(ATTR_LIST_TOTAL);
  };
}

/**
 * Mimics the library-ids half of the main-world fiber bridge
 * (`src/content/fiber-bridge.ts` → `publishLibraryIds`, #241): on every
 * `moo-request-fiber-data` it writes `ids` comma-joined onto `<html>` as
 * `data-moo-library-ids` (`[]` → `""`, a known-empty library), or removes the
 * attribute when `ids` is null — the real bridge's "unreadable". Like
 * `installListTotalPublisher` it does NOT dispatch `moo-fiber-data`. Returns a
 * cleanup that removes the listener and the attribute.
 */
export function installLibraryIdsPublisher(
  ids: readonly string[] | null,
): () => void {
  const root = document.documentElement;
  const handler = () => {
    if (ids === null) root.removeAttribute(ATTR_LIBRARY_IDS);
    else root.setAttribute(ATTR_LIBRARY_IDS, ids.join(","));
  };
  document.addEventListener("moo-request-fiber-data", handler);
  return () => {
    document.removeEventListener("moo-request-fiber-data", handler);
    root.removeAttribute(ATTR_LIBRARY_IDS);
  };
}
