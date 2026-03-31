/**
 * Page ready detection for Readmoo SPA.
 * Waits for #full-page-spinner to gain the `hide` class,
 * indicating the page has finished loading.
 */

export const PAGE_READY_TIMEOUT_MS = 5000;

const SPINNER_ID = "full-page-spinner";
const HIDE_CLASS = "hide";

/**
 * Wait for Readmoo page to finish loading by detecting #full-page-spinner's hide class.
 * Returns a Promise that resolves when the page is ready.
 * Supports cancellation via AbortSignal for SPA navigation cleanup.
 */
export function waitForPageReady(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }

  const spinner = document.getElementById(SPINNER_ID);

  // Spinner already hidden — page is ready
  if (spinner?.classList.contains(HIDE_CLASS)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const observers: MutationObserver[] = [];
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    function cleanup(): void {
      for (const obs of observers) obs.disconnect();
      observers.length = 0;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
    }

    function onReady(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function onAbort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    }

    // Wire up abort handling
    signal?.addEventListener("abort", onAbort, { once: true });

    // Timeout fallback — always resolve (Readmoo can get stuck on stale sessions)
    timeoutId = setTimeout(onReady, PAGE_READY_TIMEOUT_MS);

    if (spinner) {
      watchSpinnerClass(spinner, onReady, observers);
      return;
    }

    // Spinner not in DOM yet — wait for it to appear
    watchForSpinnerAppearance(onReady, observers);
  });
}

/** Observe an existing spinner element for the `hide` class. */
function watchSpinnerClass(
  spinner: Element,
  onReady: () => void,
  observers: MutationObserver[],
): void {
  const observer = new MutationObserver(() => {
    if (spinner.classList.contains(HIDE_CLASS)) onReady();
  });
  observer.observe(spinner, { attributes: true, attributeFilter: ["class"] });
  observers.push(observer);
}

/** Watch document.body for the spinner to appear, then observe its class. */
function watchForSpinnerAppearance(
  onReady: () => void,
  observers: MutationObserver[],
): void {
  const bodyObserver = new MutationObserver(() => {
    const spinner = document.getElementById(SPINNER_ID);
    if (!spinner) return;

    // Stop watching for appearance
    bodyObserver.disconnect();

    if (spinner.classList.contains(HIDE_CLASS)) {
      onReady();
      return;
    }

    watchSpinnerClass(spinner, onReady, observers);
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  observers.push(bodyObserver);
}
