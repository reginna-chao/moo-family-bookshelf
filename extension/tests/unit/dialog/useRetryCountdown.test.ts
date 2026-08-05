import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRetryCountdown } from "@/dialog/useRetryCountdown";

/**
 * useRetryCountdown turns a backend `retryAfter` (seconds) into a 1 Hz local
 * ticker. It performs NO I/O, so the only real risks are (a) a wrong remaining
 * value and (b) an interval that outlives its deadline — both are pinned here.
 * `vi.getTimerCount()` is asserted directly so a leaked interval fails the test
 * instead of quietly burning a timer for the rest of the suite.
 */
describe("useRetryCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderCountdown(onElapsed: () => void = vi.fn()) {
    return renderHook(() => useRetryCountdown(onElapsed));
  }

  it("starts idle with no remaining seconds and no timer", () => {
    const { result } = renderCountdown();

    expect(result.current.seconds).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exposes the full wait immediately when started, then ticks down once per second", () => {
    const { result } = renderCountdown();

    let started = false;
    act(() => {
      started = result.current.start(5);
    });

    // The first tick runs on start (not one second later), so the user never
    // sees a blank message before the countdown appears.
    expect(started).toBe(true);
    expect(result.current.seconds).toBe(5);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(4);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.seconds).toBe(2);
  });

  it("fires onElapsed once at zero, clears the remaining seconds and stops the interval", () => {
    const onElapsed = vi.fn();
    const { result } = renderCountdown(onElapsed);

    act(() => {
      result.current.start(3);
    });

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.seconds).toBe(1);
    expect(onElapsed).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBeNull();
    expect(onElapsed).toHaveBeenCalledTimes(1);
    // The interval must be gone the moment the wait ends — no idle ticking.
    expect(vi.getTimerCount()).toBe(0);

    // Well past the deadline: still exactly one call, still no timer.
    act(() => vi.advanceTimersByTime(60_000));
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["undefined (backend omitted the field)", undefined],
    ["zero", 0],
    ["a negative wait", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    // Untyped JSON can hand us a string; the hook must not start on it.
    ["a numeric string", "30" as unknown as number],
  ])("ignores %s and starts no timer", (_label, input) => {
    const onElapsed = vi.fn();
    const { result } = renderCountdown(onElapsed);

    let started = true;
    act(() => {
      started = result.current.start(input as number | undefined);
    });

    expect(started).toBe(false);
    expect(result.current.seconds).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onElapsed).not.toHaveBeenCalled();
  });

  /**
   * The hook clamps every incoming wait to one hour (`MAX_RETRY_WAIT_SECONDS`
   * in useRetryCountdown.ts). The official worker never asks for more than 900s,
   * so the cap exists purely to stop a hostile / buggy self-hosted backend from
   * arming an effectively endless ticker in the user's dialog.
   */
  it.each([
    ["a short wait", 60, 60],
    ["the longest wait the worker really sends", 900, 900],
    ["exactly the one-hour cap", 3600, 3600],
    ["a two-hour wait", 7200, 3600],
    ["a one-day wait", 86_400, 3600],
    // A fractional value above the cap must land on the cap, not on 3601.
    ["a fractional wait above the cap", 3600.5, 3600],
  ])("starts %s (%i) at %i seconds", (_label, input, expected) => {
    const { result } = renderCountdown();

    act(() => {
      result.current.start(input);
    });

    expect(result.current.seconds).toBe(expected);
    expect(vi.getTimerCount()).toBe(1);

    // The cap must move the DEADLINE, not merely the first rendered value —
    // otherwise the display would jump back up on the next tick.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(expected - 1);
  });

  it("ends an over-cap wait after one hour instead of the requested duration", () => {
    const onElapsed = vi.fn();
    const { result } = renderCountdown(onElapsed);

    // 24h from a misbehaving backend: the user must be released after the cap.
    act(() => {
      result.current.start(86_400);
    });

    act(() => vi.advanceTimersByTime(3_599_000));
    expect(result.current.seconds).toBe(1);
    expect(onElapsed).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBeNull();
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts from the new wait when start is called again mid-countdown", () => {
    const { result } = renderCountdown();

    act(() => {
      result.current.start(10);
    });
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.seconds).toBe(6);

    // A fresh 429 arrives with a longer wait — the deadline is replaced, not added to.
    act(() => {
      result.current.start(30);
    });
    expect(result.current.seconds).toBe(30);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clear() stops the countdown without firing onElapsed and leaves no timer", () => {
    const onElapsed = vi.fn();
    const { result } = renderCountdown(onElapsed);

    act(() => {
      result.current.start(30);
    });
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      result.current.clear();
    });

    expect(result.current.seconds).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("clears the interval on unmount (no setState / callback after teardown)", () => {
    const onElapsed = vi.fn();
    const { result, unmount } = renderCountdown(onElapsed);

    act(() => {
      result.current.start(30);
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => vi.advanceTimersByTime(60_000));
    expect(onElapsed).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses the latest onElapsed without restarting the countdown when its identity changes", () => {
    const first = vi.fn();
    const second = vi.fn();
    let callback = first;
    const { result, rerender } = renderHook(() => useRetryCountdown(callback));

    act(() => {
      result.current.start(3);
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(2);

    // A new callback identity (the common case for an inline arrow) must not
    // re-arm the interval — otherwise the remaining time would jump back up.
    callback = second;
    rerender();
    expect(result.current.seconds).toBe(2);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.seconds).toBeNull();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
