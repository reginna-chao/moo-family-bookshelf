import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTimedFlag } from "@/hooks/useTimedFlag";

describe("useTimedFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sets the flag true on trigger then auto-resets to false after the delay", () => {
    const { result } = renderHook(() => useTimedFlag(2000));

    expect(result.current[0]).toBe(false);

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    // Not yet elapsed.
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current[0]).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe(false);
  });

  it("restarts the timer when triggered again before it resets", () => {
    const { result } = renderHook(() => useTimedFlag(2000));

    act(() => result.current[1]());
    act(() => vi.advanceTimersByTime(1500));
    // Re-trigger — resets the 2000ms window.
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    // 1500ms after the re-trigger: the first window would have elapsed, reset one not.
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current[0]).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toBe(false);
  });

  it("clears the pending reset timer on unmount (no setState after unmount)", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useTimedFlag(2000));

    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);

    // Nothing cleared yet from the trigger (first arm, no prior timer).
    clearSpy.mockClear();
    unmount();

    // Unmount cleanup must clear the armed reset timer so the deferred
    // setActive(false) can never run on an unmounted component.
    expect(clearSpy).toHaveBeenCalled();

    // Advancing past the delay after unmount must not throw or warn.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => vi.advanceTimersByTime(5000));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
