import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFamilyShelfViewMode } from "@/hooks/useFamilyShelfViewMode";
import { namespacedKey } from "@/hooks/useAuth";

const USER_ID = "test-user-123";

describe("useFamilyShelfViewMode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 'grid' when localStorage has no value", () => {
    const { result } = renderHook(() => useFamilyShelfViewMode(USER_ID));
    expect(result.current.viewMode).toBe("grid");
  });

  it("reads 'row' from localStorage", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfViewMode"), "row");
    const { result } = renderHook(() => useFamilyShelfViewMode(USER_ID));
    expect(result.current.viewMode).toBe("row");
  });

  it("defaults to 'grid' for invalid localStorage value", () => {
    localStorage.setItem(
      namespacedKey(USER_ID, "familyShelfViewMode"),
      "invalid",
    );
    const { result } = renderHook(() => useFamilyShelfViewMode(USER_ID));
    expect(result.current.viewMode).toBe("grid");
  });

  it("updates state and writes to localStorage on setViewMode", () => {
    const { result } = renderHook(() => useFamilyShelfViewMode(USER_ID));

    act(() => {
      result.current.setViewMode("row");
    });

    expect(result.current.viewMode).toBe("row");
    expect(
      localStorage.getItem(namespacedKey(USER_ID, "familyShelfViewMode")),
    ).toBe("row");
  });

  it("uses correct namespaced key (moo:{userId}:familyShelfViewMode)", () => {
    const { result } = renderHook(() => useFamilyShelfViewMode(USER_ID));

    act(() => {
      result.current.setViewMode("row");
    });

    const expectedKey = `moo:${USER_ID}:familyShelfViewMode`;
    expect(localStorage.getItem(expectedKey)).toBe("row");
  });

  it("re-reads preference when userId changes", () => {
    const otherUserId = "other-user-456";
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfViewMode"), "row");
    localStorage.setItem(
      namespacedKey(otherUserId, "familyShelfViewMode"),
      "grid",
    );

    const { result, rerender } = renderHook(
      ({ userId }) => useFamilyShelfViewMode(userId),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.viewMode).toBe("row");

    rerender({ userId: otherUserId });
    expect(result.current.viewMode).toBe("grid");
  });

  it("defaults to 'grid' when switching to user with no stored preference", () => {
    localStorage.setItem(namespacedKey(USER_ID, "familyShelfViewMode"), "row");

    const { result, rerender } = renderHook(
      ({ userId }) => useFamilyShelfViewMode(userId),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.viewMode).toBe("row");

    rerender({ userId: "new-user" });
    expect(result.current.viewMode).toBe("grid");
  });
});
