import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSearch } from "@/dialog/useSearch";

interface TestItem {
  title: string;
  author: string;
  id: string;
}

const ITEMS: TestItem[] = [
  { id: "1", title: "React 入門指南", author: "張三" },
  { id: "2", title: "TypeScript 實戰", author: "李四" },
  { id: "3", title: "Node.js 設計模式", author: "王五" },
  { id: "4", title: "React Native 開發", author: "趙六" },
];

describe("useSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all items when search term is empty", () => {
    const { result } = renderHook(() => useSearch(ITEMS));
    expect(result.current.filteredItems).toEqual(ITEMS);
    expect(result.current.isFiltering).toBe(false);
  });

  it("filters by title after debounce", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("React");
    });

    // Before debounce: still all items
    expect(result.current.filteredItems).toEqual(ITEMS);

    // After debounce
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(2);
    expect(result.current.filteredItems[0].title).toBe("React 入門指南");
    expect(result.current.filteredItems[1].title).toBe("React Native 開發");
    expect(result.current.isFiltering).toBe(true);
  });

  it("filters by author after debounce", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("李四");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].author).toBe("李四");
  });

  it("is case-insensitive", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("react");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(2);
  });

  it("returns empty array when nothing matches", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("不存在的書");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(0);
    expect(result.current.isFiltering).toBe(true);
  });

  it("debounces intermediate inputs", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("R");
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    act(() => {
      result.current.setSearchTerm("Re");
    });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    act(() => {
      result.current.setSearchTerm("React");
    });

    // Only 200ms since last input, not yet debounced
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.filteredItems).toEqual(ITEMS);

    // After full debounce from last input
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.filteredItems).toHaveLength(2);
  });

  it("trims whitespace before filtering", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("  React  ");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(2);
  });

  it("treats whitespace-only input as no filter", () => {
    const { result } = renderHook(() => useSearch(ITEMS));

    act(() => {
      result.current.setSearchTerm("   ");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toEqual(ITEMS);
    expect(result.current.isFiltering).toBe(false);
  });

  it("supports custom debounce duration", () => {
    const { result } = renderHook(() => useSearch(ITEMS, 500));

    act(() => {
      result.current.setSearchTerm("React");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Not yet debounced at 300ms with 500ms delay
    expect(result.current.filteredItems).toEqual(ITEMS);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.filteredItems).toHaveLength(2);
  });

  it("updates filtered items when source items change", () => {
    const { result, rerender } = renderHook(({ items }) => useSearch(items), {
      initialProps: { items: ITEMS },
    });

    act(() => {
      result.current.setSearchTerm("React");
    });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(2);

    // Remove one React item
    const fewerItems = ITEMS.slice(0, 3);
    rerender({ items: fewerItems });

    expect(result.current.filteredItems).toHaveLength(1);
  });
});
