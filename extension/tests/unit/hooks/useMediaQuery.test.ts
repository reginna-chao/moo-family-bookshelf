import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ChangeListener = () => void;

function createMockMediaQueryList(
  query: string,
  matches: boolean,
): MediaQueryList & {
  _listeners: Set<ChangeListener>;
  _setMatches: (v: boolean) => void;
} {
  const listeners = new Set<ChangeListener>();
  const mql = {
    matches,
    media: query,
    onchange: null as ((ev: MediaQueryListEvent) => void) | null,
    _listeners: listeners,
    _setMatches(v: boolean) {
      mql.matches = v;
      listeners.forEach((cb) => cb());
    },
    addEventListener(
      type: string,
      cb: EventListenerOrEventListenerObject | null,
    ) {
      if (type === "change" && typeof cb === "function")
        listeners.add(cb as ChangeListener);
    },
    removeEventListener(
      type: string,
      cb: EventListenerOrEventListenerObject | null,
    ) {
      if (type === "change" && typeof cb === "function")
        listeners.delete(cb as ChangeListener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  return mql;
}

describe("useMediaQuery", () => {
  let matchMediaMocks: Map<string, ReturnType<typeof createMockMediaQueryList>>;
  let useMediaQuery: (query: string) => boolean;

  // vi.resetModules() is critical: the hook caches MediaQueryList instances
  // in a module-level Map. Without a fresh module per test, cache leaks
  // between tests and causes false passes / flaky failures.
  beforeEach(async () => {
    vi.resetModules();

    matchMediaMocks = new Map();

    vi.stubGlobal("matchMedia", (query: string) => {
      let mock = matchMediaMocks.get(query);
      if (!mock) {
        mock = createMockMediaQueryList(query, false);
        matchMediaMocks.set(query, mock);
      }
      return mock;
    });

    const mod = await import("@/hooks/useMediaQuery");
    useMediaQuery = mod.useMediaQuery;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    matchMediaMocks.clear();
  });

  it("returns true when media query matches", () => {
    const query = "(min-width: 768px)";
    matchMediaMocks.set(query, createMockMediaQueryList(query, true));

    const { result } = renderHook(() => useMediaQuery(query));
    expect(result.current).toBe(true);
  });

  it("returns false when media query does not match", () => {
    const query = "(min-width: 768px)";
    matchMediaMocks.set(query, createMockMediaQueryList(query, false));

    const { result } = renderHook(() => useMediaQuery(query));
    expect(result.current).toBe(false);
  });

  it("updates when media query changes", () => {
    const query = "(min-width: 768px)";
    const mock = createMockMediaQueryList(query, false);
    matchMediaMocks.set(query, mock);

    const { result } = renderHook(() => useMediaQuery(query));
    expect(result.current).toBe(false);

    act(() => {
      mock._setMatches(true);
    });

    expect(result.current).toBe(true);
  });

  it("removes listener on unmount", () => {
    const query = "(min-width: 768px)";
    const mock = createMockMediaQueryList(query, false);
    matchMediaMocks.set(query, mock);

    const { unmount } = renderHook(() => useMediaQuery(query));
    expect(mock._listeners.size).toBe(1);

    unmount();
    expect(mock._listeners.size).toBe(0);
  });

  it("shares cached MediaQueryList for the same query string", () => {
    const query = "(min-width: 768px)";
    const matchMediaSpy = vi.fn((q: string) => {
      let mock = matchMediaMocks.get(q);
      if (!mock) {
        mock = createMockMediaQueryList(q, false);
        matchMediaMocks.set(q, mock);
      }
      return mock;
    });
    vi.stubGlobal("matchMedia", matchMediaSpy);

    const { result: resultA } = renderHook(() => useMediaQuery(query));
    const { result: resultB } = renderHook(() => useMediaQuery(query));

    // matchMedia should only be called once for the same query
    expect(matchMediaSpy).toHaveBeenCalledTimes(1);

    // Both hooks share the same value
    expect(resultA.current).toBe(false);
    expect(resultB.current).toBe(false);

    // Changing the mock updates both hooks
    const mock = matchMediaMocks.get(query)!;
    act(() => {
      mock._setMatches(true);
    });

    expect(resultA.current).toBe(true);
    expect(resultB.current).toBe(true);
  });

  it("different query strings work independently", () => {
    const queryA = "(min-width: 768px)";
    const queryB = "(prefers-color-scheme: dark)";
    const mockA = createMockMediaQueryList(queryA, true);
    const mockB = createMockMediaQueryList(queryB, false);
    matchMediaMocks.set(queryA, mockA);
    matchMediaMocks.set(queryB, mockB);

    const { result: resultA } = renderHook(() => useMediaQuery(queryA));
    const { result: resultB } = renderHook(() => useMediaQuery(queryB));

    expect(resultA.current).toBe(true);
    expect(resultB.current).toBe(false);

    act(() => {
      mockB._setMatches(true);
    });

    expect(resultA.current).toBe(true);
    expect(resultB.current).toBe(true);
  });
});
