/**
 * Fiber-bridge client.
 *
 * Injects the main-world `fiber-bridge.js` script and asks it to stamp
 * `data-moo-book-id` (and related metadata) onto every `.library-item` node.
 *
 * Shared by the bookshelf scraper (sync flow) and the lending search flow so
 * the stamping logic lives in exactly one place — do not duplicate it.
 */

import browser from "webextension-polyfill";

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
