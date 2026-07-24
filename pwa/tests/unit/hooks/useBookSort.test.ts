import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBookSort } from "@/hooks/useBookSort";
import { namespacedKey } from "@/hooks/useAuth";
import type { BookSortShelf } from "@/hooks/useBookSort";
import type { BookSortMode } from "@/utils/sortBooks";

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
  ])(
    "reads stored value from correct key for shelf '$shelf'",
    ({ shelf, suffix }) => {
      localStorage.setItem(namespacedKey(USER_ID, suffix), "title-desc");
      const { result } = renderHook(() => useBookSort(USER_ID, shelf));
      expect(result.current.sort).toBe("title-desc");
    },
  );

  it.each<{ stored: string; expected: BookSortMode }>([
    { stored: "title", expected: "title-asc" },
    { stored: "author", expected: "author-asc" },
  ])(
    "normalizes legacy stored value '$stored' to '$expected'",
    ({ stored, expected }) => {
      localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), stored);
      const { result } = renderHook(() => useBookSort(USER_ID, "family"));
      expect(result.current.sort).toBe(expected);
    },
  );

  it("defaults to 'default' for invalid localStorage value", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfSort"), "invalid");
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));
    expect(result.current.sort).toBe("default");
  });

  it("updates state and writes to localStorage on setSort", () => {
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));

    act(() => {
      result.current.setSort("author-desc");
    });

    expect(result.current.sort).toBe("author-desc");
    expect(
      localStorage.getItem(namespacedKey(USER_ID, "familyShelfSort")),
    ).toBe("author-desc");
  });

  it("writes to correct key for personal shelf", () => {
    const { result } = renderHook(() => useBookSort(USER_ID, "personal"));

    act(() => {
      result.current.setSort("title-asc");
    });

    expect(
      localStorage.getItem(namespacedKey(USER_ID, "personalShelfSort")),
    ).toBe("title-asc");
  });

  it("re-reads preference when userId changes", () => {
    const otherUserId = "other-user-456";
    localStorage.setItem(
      namespacedKey(USER_ID, "familyShelfSort"),
      "title-asc",
    );
    localStorage.setItem(
      namespacedKey(otherUserId, "familyShelfSort"),
      "author-desc",
    );

    const { result, rerender } = renderHook(
      ({ userId }) => useBookSort(userId, "family"),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.sort).toBe("title-asc");

    rerender({ userId: otherUserId });
    expect(result.current.sort).toBe("author-desc");
  });

  it("re-reads preference when shelf changes", () => {
    localStorage.setItem(
      namespacedKey(USER_ID, "familyShelfSort"),
      "title-asc",
    );
    localStorage.setItem(
      namespacedKey(USER_ID, "personalShelfSort"),
      "author-desc",
    );

    const { result, rerender } = renderHook(
      ({ shelf }) => useBookSort(USER_ID, shelf),
      { initialProps: { shelf: "family" as BookSortShelf } },
    );
    expect(result.current.sort).toBe("title-asc");

    rerender({ shelf: "personal" });
    expect(result.current.sort).toBe("author-desc");
  });

  it("keeps a stored preference instead of falling back to default", () => {
    localStorage.setItem(
      namespacedKey(USER_ID, "familyShelfSort"),
      "title-desc",
    );
    const { result } = renderHook(() => useBookSort(USER_ID, "family"));
    expect(result.current.sort).toBe("title-desc");
  });

  it("defaults to 'default' when switching to user with no stored preference", () => {
    localStorage.setItem(
      namespacedKey(USER_ID, "familyShelfSort"),
      "title-asc",
    );

    const { result, rerender } = renderHook(
      ({ userId }) => useBookSort(userId, "family"),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.sort).toBe("title-asc");

    rerender({ userId: "new-user" });
    expect(result.current.sort).toBe("default");
  });
});
