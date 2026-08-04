import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRetryCountdown } from "@/hooks/useRetryCountdown";

describe("useRetryCountdown (PWA)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts idle with no remaining time and no armed timer", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useRetryCountdown(onExpire));

    expect(result.current.remaining).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(10_000));
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("shows the full delay immediately and counts down once per second", () => {
    const { result } = renderHook(() => useRetryCountdown());

    act(() => result.current.start(3));
    expect(result.current.remaining).toBe(3);

    act(() => vi.advanceTimersByTime(999));
    expect(result.current.remaining).toBe(3);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.remaining).toBe(2);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remaining).toBe(1);
  });

  it("rounds a fractional delay up to whole seconds", () => {
    const { result } = renderHook(() => useRetryCountdown());

    act(() => result.current.start(2.4));
    expect(result.current.remaining).toBe(3);

    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.remaining).toBe(0);
  });

  it("fires onExpire exactly once at zero and stops ticking", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useRetryCountdown(onExpire));

    act(() => result.current.start(3));

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.remaining).toBe(1);
    expect(onExpire).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remaining).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(result.current.remaining).toBe(0);
  });

  it("derives the remaining value from the wall clock after a throttled gap", () => {
    const { result } = renderHook(() => useRetryCountdown());

    act(() => result.current.start(10));
    expect(result.current.remaining).toBe(10);

    // Tab was throttled: 8 real seconds passed without the interval firing.
    act(() => vi.setSystemTime(Date.now() + 8000));
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.remaining).toBe(1);
  });

  describe("non-positive delays", () => {
    it.each<[string, number]>([
      ["zero", 0],
      ["negative", -1],
      ["fractional negative", -0.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ])("does not arm the countdown for %s", (_label, seconds) => {
      const onExpire = vi.fn();
      const { result } = renderHook(() => useRetryCountdown(onExpire));

      act(() => result.current.start(seconds));

      expect(result.current.remaining).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      act(() => vi.advanceTimersByTime(10_000));
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("does not arm the countdown for an undefined delay", () => {
      const onExpire = vi.fn();
      const { result } = renderHook(() => useRetryCountdown(onExpire));

      // Callers pass through an optional API hint (`retryAfter`).
      act(() => result.current.start(undefined as unknown as number));

      expect(result.current.remaining).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops a running countdown without firing onExpire", () => {
      const onExpire = vi.fn();
      const { result } = renderHook(() => useRetryCountdown(onExpire));

      act(() => result.current.start(5));
      act(() => vi.advanceTimersByTime(2000));
      expect(result.current.remaining).toBe(3);

      act(() => result.current.start(0));

      expect(result.current.remaining).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      act(() => vi.advanceTimersByTime(10_000));
      expect(onExpire).not.toHaveBeenCalled();
    });
  });

  describe("hostile or misconfigured delays", () => {
    // A BYO backend could answer a 429 with an absurd wait and freeze the UI, so
    // the hook caps the armed countdown at one hour.
    const ONE_HOUR = 3600;

    it.each<[string, number, number]>([
      ["just below the cap", ONE_HOUR - 1, ONE_HOUR - 1],
      ["exactly at the cap", ONE_HOUR, ONE_HOUR],
      ["one second above the cap", ONE_HOUR + 1, ONE_HOUR],
      ["two hours", 7200, ONE_HOUR],
      ["a full day", 86_400, ONE_HOUR],
    ])("starts %s at %i seconds as %i", (_label, requested, expected) => {
      const { result } = renderHook(() => useRetryCountdown());

      act(() => result.current.start(requested));

      expect(result.current.remaining).toBe(expected);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("ticks down from the clamped value, not the requested one", () => {
      const { result } = renderHook(() => useRetryCountdown());

      act(() => result.current.start(7200));

      act(() => vi.advanceTimersByTime(1000));
      expect(result.current.remaining).toBe(ONE_HOUR - 1);
    });

    it("expires after the clamped hour instead of the requested wait", () => {
      const onExpire = vi.fn();
      const { result } = renderHook(() => useRetryCountdown(onExpire));

      act(() => result.current.start(86_400));

      // Jump the wall clock past the clamped deadline, then let one tick run.
      act(() => vi.setSystemTime(Date.now() + ONE_HOUR * 1000));
      act(() => vi.advanceTimersByTime(1000));

      expect(result.current.remaining).toBe(0);
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("supersedes a running countdown with a single timer on re-start", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useRetryCountdown(onExpire));

    act(() => result.current.start(5));
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.remaining).toBe(3);

    act(() => result.current.start(10));
    expect(result.current.remaining).toBe(10);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(9000));
    expect(result.current.remaining).toBe(1);
    expect(onExpire).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remaining).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("clear() stops the countdown without firing onExpire", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useRetryCountdown(onExpire));

    act(() => result.current.start(5));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.remaining).toBe(4);

    act(() => result.current.clear());

    expect(result.current.remaining).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(10_000));
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("clear() is a no-op when nothing is running", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() => useRetryCountdown(onExpire));

    act(() => result.current.clear());

    expect(result.current.remaining).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("clears the running interval on unmount (no leaked timer, no late onExpire)", () => {
    const onExpire = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useRetryCountdown(onExpire));

    act(() => result.current.start(5));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(10_000));
    expect(onExpire).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("invokes the latest onExpire callback, not the one captured at mount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onExpire }: { onExpire: () => void }) => useRetryCountdown(onExpire),
      { initialProps: { onExpire: first } },
    );

    act(() => result.current.start(2));
    rerender({ onExpire: second });

    act(() => vi.advanceTimersByTime(2000));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("works without an onExpire callback", () => {
    const { result } = renderHook(() => useRetryCountdown());

    act(() => result.current.start(1));
    expect(() => act(() => vi.advanceTimersByTime(1000))).not.toThrow();
    expect(result.current.remaining).toBe(0);
  });
});
