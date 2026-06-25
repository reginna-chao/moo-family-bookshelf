import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MOBILE_BREAKPOINT_PX, MOBILE_MEDIA_QUERY } from "@/hooks/breakpoints";

type ChangeListener = () => void;

function createMockMql(query: string, matches: boolean) {
  const listeners = new Set<ChangeListener>();
  const mql = {
    matches,
    media: query,
    onchange: null as ((ev: MediaQueryListEvent) => void) | null,
    _setMatches(v: boolean) {
      mql.matches = v;
      listeners.forEach((cb) => cb());
    },
    addEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof cb === "function") listeners.add(cb as ChangeListener);
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (type === "change" && typeof cb === "function") listeners.delete(cb as ChangeListener);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  return mql;
}

describe("breakpoints", () => {
  it("defines the mobile cutoff at 767px", () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(767);
  });

  it("derives the media query from the breakpoint constant", () => {
    expect(MOBILE_MEDIA_QUERY).toBe(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`);
  });
});

describe("useIsMobile", () => {
  let mocks: Map<string, ReturnType<typeof createMockMql>>;
  let useIsMobile: () => boolean;

  beforeEach(async () => {
    vi.resetModules();
    mocks = new Map();
    vi.stubGlobal("matchMedia", (query: string) => {
      let mock = mocks.get(query);
      if (!mock) {
        mock = createMockMql(query, false);
        mocks.set(query, mock);
      }
      return mock;
    });
    const mod = await import("@/hooks/useIsMobile");
    useIsMobile = mod.useIsMobile;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.clear();
  });

  it("queries the mobile breakpoint media query", () => {
    renderHook(() => useIsMobile());
    expect(mocks.has(MOBILE_MEDIA_QUERY)).toBe(true);
  });

  it("returns false when the viewport is above the breakpoint", () => {
    mocks.set(MOBILE_MEDIA_QUERY, createMockMql(MOBILE_MEDIA_QUERY, false));
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("returns true when the viewport is at or below the breakpoint", () => {
    mocks.set(MOBILE_MEDIA_QUERY, createMockMql(MOBILE_MEDIA_QUERY, true));
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("updates when the breakpoint changes", () => {
    const mock = createMockMql(MOBILE_MEDIA_QUERY, false);
    mocks.set(MOBILE_MEDIA_QUERY, mock);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => mock._setMatches(true));
    expect(result.current).toBe(true);
  });
});
