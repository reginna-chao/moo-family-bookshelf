/**
 * Hash navigation of the Readmoo SPA from the Dialog (same document, content
 * script isolated world): go to a route, wait for it to render, read the DOM.
 * Shared by onboarding (dialog/useAutoSetup.ts) and the boot-time account check
 * (dialog/accountIdentityCheck.ts).
 */

import { scrapeUserEmail, scrapeDisplayName } from "./scraper";

/** Delay in ms to wait for page render after hash navigation */
export const NAV_SETTLE_MS = 1500;

function abortError(): DOMException {
  return new DOMException("Hash navigation aborted", "AbortError");
}

/** Resolve after `ms`; reject early (timer cleared) when `signal` aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Navigate the host SPA to a hash route, wait for render, then run a task.
 * Returns the result of the task function. Does NOT restore the hash — the
 * caller owns that, on every path.
 */
export async function navigateAndRun<T>(
  hash: string,
  task: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  window.location.hash = hash;
  await wait(NAV_SETTLE_MS, signal);
  return task();
}

export interface MePageProfile {
  /** null when the profile panel shows no email (logged out, DOM changed, slow page). */
  email: string | null;
  displayName: string;
}

/**
 * Read the logged-in account from Readmoo's `#/me` profile panel, then put the
 * page back on the hash it was on — on every path, errors and aborts included.
 * Rejects on abort or a failed scrape; nothing is written anywhere.
 */
export async function readMePageProfile(
  signal?: AbortSignal,
): Promise<MePageProfile> {
  if (signal?.aborted) throw abortError();
  const originalHash = window.location.hash;
  try {
    return await navigateAndRun(
      "#/me",
      () => ({
        email: scrapeUserEmail(),
        displayName: scrapeDisplayName() ?? "",
      }),
      signal,
    );
  } finally {
    window.location.hash = originalHash || "#/";
  }
}
