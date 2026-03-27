import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSearch } from "@/hooks/useSearch";

interface TestItem {
  title: string;
  author: string;
  id: number;
}

const items: TestItem[] = [
  { id: 1, title: "React in Action", author: "Mark Thomas" },
  { id: 2, title: "TypeScript Handbook", author: "Daniel Rosenwasser" },
  { id: 3, title: "Learning Vue", author: "Callum Macrae" },
  { id: 4, title: "Rust Programming", author: "Steve Klabnik" },
];

describe("useSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all items when search term is empty", () => {
    const { result } = renderHook(() => useSearch(items));

    expect(result.current.filteredItems).toEqual(items);
    expect(result.current.filteredItems).toHaveLength(4);
  });

  it("filters items by title match (case-insensitive)", () => {
    const { result } = renderHook(() => useSearch(items));

    act(() => {
      result.current.setSearchTerm("react");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].title).toBe("React in Action");
  });

  it("filters items by author match", () => {
    const { result } = renderHook(() => useSearch(items));

    act(() => {
      result.current.setSearchTerm("Klabnik");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].title).toBe("Rust Programming");
  });

  it("returns empty array when no matches", () => {
    const { result } = renderHook(() => useSearch(items));

    act(() => {
      result.current.setSearchTerm("nonexistent");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.filteredItems).toHaveLength(0);
  });

  it("isFiltering is false when search term is empty", () => {
    const { result } = renderHook(() => useSearch(items));

    expect(result.current.isFiltering).toBe(false);
  });

  it("isFiltering is true when search term is non-empty", () => {
    const { result } = renderHook(() => useSearch(items));

    act(() => {
      result.current.setSearchTerm("react");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current.isFiltering).toBe(true);
  });

  it("debounces search", () => {
    const { result } = renderHook(() => useSearch(items, 500));

    act(() => {
      result.current.setSearchTerm("react");
    });

    // Before debounce fires, still shows all items
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.filteredItems).toEqual(items);
    expect(result.current.isFiltering).toBe(false);

    // After debounce fires, shows filtered items
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].title).toBe("React in Action");
    expect(result.current.isFiltering).toBe(true);
  });

  it("resets debounce timer when search term changes rapidly", () => {
    const { result } = renderHook(() => useSearch(items, 300));

    act(() => {
      result.current.setSearchTerm("ty");
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Change term before debounce fires
    act(() => {
      result.current.setSearchTerm("typescript");
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // First term's debounce should not have fired
    expect(result.current.filteredItems).toEqual(items);

    // Now let the second debounce complete
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.filteredItems).toHaveLength(1);
    expect(result.current.filteredItems[0].title).toBe("TypeScript Handbook");
  });
});
