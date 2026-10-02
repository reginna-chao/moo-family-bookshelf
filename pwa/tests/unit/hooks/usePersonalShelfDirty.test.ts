import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersonalShelfDirty } from "@/hooks/usePersonalShelfDirty";

/**
 * `clearDirtyIds` is what a successful save calls (#250): it clears only the
 * ids the save really saved, so an id marked while the save was in flight
 * stays unsaved.
 */
describe("usePersonalShelfDirty — clearDirtyIds", () => {
  function renderWithDirty(ids: string[]) {
    const hook = renderHook(() => usePersonalShelfDirty());
    act(() => {
      hook.result.current.markManyDirty(ids);
    });
    return hook;
  }

  it("clears only the given ids and keeps the rest dirty", () => {
    const { result } = renderWithDirty(["a", "b", "c"]);

    act(() => {
      result.current.clearDirtyIds(["a", "c"]);
    });

    expect([...result.current.dirtyBookIds]).toEqual(["b"]);
    expect(result.current.isDirty).toBe(true);
  });

  it("ends not dirty once every id is cleared", () => {
    const { result } = renderWithDirty(["a", "b"]);

    act(() => {
      result.current.clearDirtyIds(new Set(["a", "b"]));
    });

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
  });

  it.each([
    { label: "an empty list", ids: [] as string[] },
    { label: "ids that are not dirty", ids: ["x", "y"] },
  ])("returns the same Set instance when $label removes nothing", ({ ids }) => {
    const { result } = renderWithDirty(["a"]);
    const before = result.current.dirtyBookIds;

    act(() => {
      result.current.clearDirtyIds(ids);
    });

    expect(result.current.dirtyBookIds).toBe(before);
    expect([...result.current.dirtyBookIds]).toEqual(["a"]);
  });

  it("returns a new Set instance when something was removed", () => {
    const { result } = renderWithDirty(["a", "b"]);
    const before = result.current.dirtyBookIds;

    act(() => {
      result.current.clearDirtyIds(["a"]);
    });

    expect(result.current.dirtyBookIds).not.toBe(before);
    // The previous Set is not mutated in place.
    expect([...before].sort()).toEqual(["a", "b"]);
  });
});
