import { describe, it, expect, vi, afterEach } from "vitest";
import {
  waitForPageReady,
  PAGE_READY_TIMEOUT_MS,
} from "../../src/content/pageReady";

const SPINNER_ID = "full-page-spinner";
const HIDE_CLASS = "hide";

function createSpinner(...classes: string[]): HTMLElement {
  const el = document.createElement("div");
  el.id = SPINNER_ID;
  if (classes.length) el.classList.add(...classes);
  document.body.appendChild(el);
  return el;
}

describe("waitForPageReady", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves immediately when spinner already has hide class", async () => {
    createSpinner(HIDE_CLASS);
    await expect(waitForPageReady()).resolves.toBeUndefined();
  });

  it("resolves when spinner exists without hide, then hide is added", async () => {
    const spinner = createSpinner();

    const promise = waitForPageReady();

    // Mutate after calling waitForPageReady so the observer picks it up
    spinner.classList.add(HIDE_CLASS);

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves when spinner not in DOM, then appears with hide class", async () => {
    const promise = waitForPageReady();

    // Spinner appears already hidden
    createSpinner(HIDE_CLASS);

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves when spinner not in DOM, then appears without hide, then gets hide", async () => {
    const promise = waitForPageReady();

    // Spinner appears without hide
    const spinner = createSpinner();

    // Give the body observer a chance to fire and set up the class observer
    await new Promise((r) => setTimeout(r, 0));

    // Now add the hide class
    spinner.classList.add(HIDE_CLASS);

    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves after PAGE_READY_TIMEOUT_MS when no spinner appears", async () => {
    vi.useFakeTimers();

    const promise = waitForPageReady();

    // Should not be resolved yet
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(PAGE_READY_TIMEOUT_MS - 1);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(true);
  });

  it("resolves after timeout when spinner exists without hide class", async () => {
    vi.useFakeTimers();
    createSpinner();

    const promise = waitForPageReady();

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(PAGE_READY_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("rejects immediately with AbortError when signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    try {
      await waitForPageReady(controller.signal);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
      expect((err as DOMException).message).toBe("Aborted");
    }
  });

  it("rejects with AbortError when signal is aborted during wait", async () => {
    const controller = new AbortController();
    createSpinner(); // spinner without hide — will wait

    const promise = waitForPageReady(controller.signal);

    controller.abort();

    await expect(promise).rejects.toThrow("Aborted");
    await expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("resolves via timeout when spinner appears then is immediately removed", async () => {
    vi.useFakeTimers();

    const promise = waitForPageReady();

    // Spinner appears then immediately removed (rapid DOM churn)
    const spinner = createSpinner();
    await Promise.resolve(); // let body observer fire
    spinner.remove();

    // Timeout should still resolve it
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(PAGE_READY_TIMEOUT_MS);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("disconnects all MutationObservers after resolution", async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");

    const spinner = createSpinner();
    const promise = waitForPageReady();

    spinner.classList.add(HIDE_CLASS);
    await promise;

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it("does not cause issues when abort happens after resolve", async () => {
    const controller = new AbortController();
    const spinner = createSpinner();

    const promise = waitForPageReady(controller.signal);

    // Resolve first
    spinner.classList.add(HIDE_CLASS);
    await promise;

    // Abort after resolution — should not throw
    controller.abort();

    // Verify promise is still resolved (not rejected)
    await expect(promise).resolves.toBeUndefined();
  });
});
