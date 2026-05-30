import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBookSort } from "@/hooks/useBookSort";
import { namespacedKey } from "@/hooks/useAuth";
import type { BookSortShelf } from "@/hooks/useBookSort";

const USER_ID = "test-user-123";

describe("useBookSort", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 'default' when localStorage has no value", () => {
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));
    expect(result.current.sort).toBe("default");
  });

  it.each<{ shelf: BookSortShelf; suffix: string }>([
    { shelf: "family", suffix: "familyShelfSort" },
    { shelf: "personal", suffix: "personalShelfSort" },
  ])("reads from correct key for shelf '$shelf'", ({ shelf, suffix }) => {
    localStorage.setItem(namespacedKey(USER_ID, suffix), "title");
    const { result } = renderHook(() => useBookSort(USER_ID, shelf));
    expect(result.current.sort).toBe("title");
  });

  it("defaults to 'default' for invalid localStorage value", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), "invalid");
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));
    expect(result.current.sort).toBe("default");
  });

  it("updates state and writes to localStorage on setSort", () => {
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));

    act(() => {
      result.current.setSort("author");
    });

    expect(result.current.sort).toBe("author");
    expect(localStorage.getItem(namespacedKey(USER_ID, "familyShelfSort"))).toBe("author");
  });

  it("writes to correct key for personal shelf", () => {
    const { result } = renderHook(() => useBookSort(USER_ID, "personal"));

    act(() => {
      result.current.setSort("title");
    });

    expect(localStorage.getItem(namespacedKey(USER_ID, "personalShelfSort"))).toBe("title");
  });

  it("re-reads preference when userId changes", () => {
    const otherUserId = "other-user-456";
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), "title");
    localStorage.setItem(namespacedKey(otherUserId, "familyShelfSort"), "author");

    const { result, rerender } = renderHook(
      ({ userId }) => useBookSort(userId, "family"),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.sort).toBe("title");

    rerender({ userId: otherUserId });
    expect(result.current.sort).toBe("author");
  });

  it("re-reads preference when shelf changes", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), "title");
    localStorage.setItem(namespacedKey(USER_ID, "personalShelfSort"), "author");

    const { result, rerender } = renderHook(
      ({ shelf }) => useBookSort(USER_ID, shelf),
      { initialProps: { shelf: "family" as BookSortShelf } },
    );
    expect(result.current.sort).toBe("title");

    rerender({ shelf: "personal" });
    expect(result.current.sort).toBe("author");
  });

  it("defaults to 'default' when switching to user with no stored preference", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), "title");

    const { result, rerender } = renderHook(
      ({ userId }) => useBookSort(userId, "family"),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.sort).toBe("title");

    rerender({ userId: "new-user" });
    expect(result.current.sort).toBe("default");
  });
});
