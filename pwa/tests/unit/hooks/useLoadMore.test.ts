import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLoadMore } from "@/hooks/useLoadMore";

function makeItems(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

describe("useLoadMore", () => {
  describe("initial state", () => {
    it.each([
      {
        items: 100,
        pageSize: 100,
        expectedVisible: 100,
        expectedHasMore: false,
      },
      {
        items: 250,
        pageSize: 100,
        expectedVisible: 100,
        expectedHasMore: true,
      },
      { items: 80, pageSize: 100, expectedVisible: 80, expectedHasMore: false },
      { items: 120, pageSize: 50, expectedVisible: 50, expectedHasMore: true },
    ])(
      "items=$items pageSize=$pageSize → visible=$expectedVisible hasMore=$expectedHasMore",
      ({ items, pageSize, expectedVisible, expectedHasMore }) => {
        const { result } = renderHook(() =>
          useLoadMore({
            items: makeItems(items),
            pageSize,
            narrowingActive: false,
          }),
        );

        expect(result.current.visibleItems).toHaveLength(expectedVisible);
        expect(result.current.hasMore).toBe(expectedHasMore);
      },
    );
  });

  describe("loadMore", () => {
    it("appends pageSize each call until exhausted", () => {
      const { result } = renderHook(() =>
        useLoadMore({ items: makeItems(250), narrowingActive: false }),
      );

      expect(result.current.visibleItems).toHaveLength(100);
      expect(result.current.hasMore).toBe(true);

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(200);
      expect(result.current.hasMore).toBe(true);

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(250);
      expect(result.current.hasMore).toBe(false);
    });

    it("respects a custom pageSize", () => {
      const { result } = renderHook(() =>
        useLoadMore({
          items: makeItems(120),
          pageSize: 50,
          narrowingActive: false,
        }),
      );

      expect(result.current.visibleItems).toHaveLength(50);
      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(100);
      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(120);
      expect(result.current.hasMore).toBe(false);
    });

    it("is a no-op when narrowingActive is true", () => {
      const { result } = renderHook(() =>
        useLoadMore({ items: makeItems(250), narrowingActive: true }),
      );

      expect(result.current.visibleItems).toHaveLength(250);
      expect(result.current.hasMore).toBe(false);

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(250);
      expect(result.current.hasMore).toBe(false);
    });
  });

  describe("reset", () => {
    it("returns visibleCount back to pageSize", () => {
      const { result } = renderHook(() =>
        useLoadMore({ items: makeItems(250), narrowingActive: false }),
      );

      act(() => result.current.loadMore());
      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(250);

      act(() => result.current.reset());
      expect(result.current.visibleItems).toHaveLength(100);
      expect(result.current.hasMore).toBe(true);
    });
  });

  describe("narrowingActive transitions (Q-C)", () => {
    it("auto-resets when narrowingActive flips from true to false", () => {
      const { result, rerender } = renderHook(
        ({ narrowing }) =>
          useLoadMore({ items: makeItems(250), narrowingActive: narrowing }),
        { initialProps: { narrowing: false } },
      );

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(200);

      rerender({ narrowing: true });
      expect(result.current.visibleItems).toHaveLength(250);
      expect(result.current.hasMore).toBe(false);

      rerender({ narrowing: false });
      expect(result.current.visibleItems).toHaveLength(100);
    });

    it("hasMore is always false while narrowingActive is true", () => {
      const { result } = renderHook(() =>
        useLoadMore({ items: makeItems(5000), narrowingActive: true }),
      );

      expect(result.current.hasMore).toBe(false);
    });
  });

  describe("items length changes", () => {
    it("does not reset visibleCount when items list changes", () => {
      const { result, rerender } = renderHook(
        ({ items }) => useLoadMore({ items, narrowingActive: false }),
        { initialProps: { items: makeItems(250) } },
      );

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(200);

      rerender({ items: makeItems(300) });
      // visibleCount stays at 200; slice(0, 200) of 300 items → still 200 visible
      expect(result.current.visibleItems).toHaveLength(200);
      expect(result.current.hasMore).toBe(true);
    });

    it("handles items shrinking below visibleCount without resetting", () => {
      const { result, rerender } = renderHook(
        ({ items }) => useLoadMore({ items, narrowingActive: false }),
        { initialProps: { items: makeItems(250) } },
      );

      act(() => result.current.loadMore());
      expect(result.current.visibleItems).toHaveLength(200);

      rerender({ items: makeItems(150) });
      // slice(0, 200) of 150 items → all 150 visible
      expect(result.current.visibleItems).toHaveLength(150);
      expect(result.current.hasMore).toBe(false);
    });
  });
});
