/** Fiber-bridge client: injects main-world `fiber-bridge.js` and asks it to stamp `.library-item` nodes.
 *  Shared by the scraper (sync) and the lending search, so the stamping exists once — never duplicate it. */

import browser from "webextension-polyfill";
import { isRealBookId } from "moo-family-bookshelf-shared/api/bookId";

const FIBER_BRIDGE_LOAD_MS = 100;
const FIBER_DATA_TIMEOUT_MS = 2000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inject the fiber-bridge script into the page's main world (idempotent).
 * Returns `true` if a new script was injected this call, `false` if the bridge
 * was already present — letting callers skip the load wait on repeat calls.
 */
export function injectFiberBridge(): boolean {
  if (document.documentElement.hasAttribute("data-moo-fiber-bridge"))
    return false;
  document.documentElement.setAttribute("data-moo-fiber-bridge", "1");
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("fiber-bridge.js");
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);
  return true;
}

/**
 * Request the fiber bridge to stamp `data-moo-book-id` on all `.library-item`
 * elements. Resolves when the bridge signals completion, or after a timeout so
 * callers never hang if the bridge is unavailable. The response listener is torn
 * down via AbortController on both the event and timeout paths — no leak.
 */
export async function requestFiberData(): Promise<void> {
  // Only wait for script load when we actually injected it this call; repeat
  // calls (e.g. the lending search poll) reuse the already-loaded bridge.
  if (injectFiberBridge()) {
    await wait(FIBER_BRIDGE_LOAD_MS);
  }

  return new Promise((resolve) => {
    const controller = new AbortController();
    const finish = () => {
      controller.abort();
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, FIBER_DATA_TIMEOUT_MS);
    document.addEventListener("moo-fiber-data", finish, {
      once: true,
      signal: controller.signal,
    });
    document.dispatchEvent(new CustomEvent("moo-request-fiber-data"));
  });
}

/** Set on `<html>` by the bridge: item count of the library's current filter. */
export const ATTR_LIST_TOTAL = "data-moo-list-total";
/** Set on `<html>` by the bridge: every book id Readmoo holds for the account, comma-joined. Must
 *  equal `ATTR_LIBRARY_IDS` in `fiber-bridge.ts` (separate bundles). */
export const ATTR_LIBRARY_IDS = "data-moo-library-ids";

/** The list total the bridge published, or null when absent / malformed. */
function readListTotal(): number | null {
  const raw = document.documentElement.getAttribute(ATTR_LIST_TOTAL);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const total = Number(raw);
  return Number.isSafeInteger(total) ? total : null;
}

/** The library ids the bridge published (real ids only), or null when the attribute is absent. */
function readLibraryIds(): ReadonlySet<string> | null {
  const raw = document.documentElement.getAttribute(ATTR_LIBRARY_IDS);
  if (raw === null) return null;
  return new Set(raw.split(",").filter((id) => isRealBookId(id)));
}

/**
 * Stamp the cards (as `requestFiberData`) and read how many items the library
 * holds for the current filter. The attribute is cleared first, so a bridge
 * that never answers — or answers without a total — yields null (unknown),
 * never a value left over from an earlier request.
 */
export async function requestLibraryListTotal(): Promise<number | null> {
  document.documentElement.removeAttribute(ATTR_LIST_TOTAL);
  await requestFiberData();
  return readListTotal();
}

export interface LibraryFiberData {
  /** As `requestLibraryListTotal`. */
  listTotal: number | null;
  /** Every real book id Readmoo holds for the account (owned, archived, lent-out, borrowed-in); null
   *  when unreadable. An empty set means the bridge read three empty lists. */
  libraryIds: ReadonlySet<string> | null;
}

/**
 * One bridge request that stamps the cards and reads both the list total and
 * the account's library ids. Both attributes are cleared first, so a bridge
 * that never answers yields null for each — never a stale value.
 */
export async function requestLibraryFiberData(): Promise<LibraryFiberData> {
  const root = document.documentElement;
  root.removeAttribute(ATTR_LIST_TOTAL);
  root.removeAttribute(ATTR_LIBRARY_IDS);
  await requestFiberData();
  return { listTotal: readListTotal(), libraryIds: readLibraryIds() };
}
