import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

describe("useDebouncedCallback (PWA)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes the callback only after the delay elapses", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(cb, 1000));

    act(() => result.current("payload"));
    act(() => vi.advanceTimersByTime(999));
    expect(cb).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("payload");
  });

  it("resets the timer on a second call so only the last invocation fires", () => {
    const cb = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(cb, 1000));

    act(() => result.current("first"));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current("second"));

    act(() => vi.advanceTimersByTime(500));
    expect(cb).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(500));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("second");
  });

  it("does NOT fire a pending callback after unmount (leak fix)", () => {
    const cb = vi.fn();
    const { result, unmount } = renderHook(() =>
      useDebouncedCallback(cb, 1000),
    );

    act(() => result.current("queued"));
    unmount();

    act(() => vi.advanceTimersByTime(5000));
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns a referentially stable function across re-renders", () => {
    const { result, rerender } = renderHook(
      ({ fn }: { fn: (...args: unknown[]) => void }) =>
        useDebouncedCallback(fn, 1000),
      { initialProps: { fn: vi.fn() } },
    );

    const firstRef = result.current;
    rerender({ fn: vi.fn() });
    expect(result.current).toBe(firstRef);
  });

  it("always invokes the latest fn closure, not the one captured at mount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ fn }: { fn: (...args: unknown[]) => void }) =>
        useDebouncedCallback(fn, 1000),
      { initialProps: { fn: first } },
    );

    rerender({ fn: second });
    act(() => result.current("value"));
    act(() => vi.advanceTimersByTime(1000));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("value");
  });
});
