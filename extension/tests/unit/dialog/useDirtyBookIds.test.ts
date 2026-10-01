import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDirtyBookIds } from "@/dialog/useDirtyBookIds";

const A = "210000000000001";
const B = "210000000000002";
const OLD_X = "210000000000011";
const NEW_Y = "210000000000012";

function renderDirty(initial: string[]) {
  const hook = renderHook(() => useDirtyBookIds());
  act(() => {
    hook.result.current.markManyDirty(initial);
  });
  return hook;
}

describe("useDirtyBookIds", () => {
  describe("clearDirtyIds", () => {
    it("clears only the given ids and keeps every other dirty id", () => {
      const { result } = renderDirty([A, B, NEW_Y]);

      act(() => {
        result.current.clearDirtyIds([A, OLD_X]);
      });

      expect([...result.current.dirtyBookIds].sort()).toEqual(
        [B, NEW_Y].sort(),
      );
      expect(result.current.dirtyRef.current).toBe(result.current.dirtyBookIds);
    });

    it("keeps the same Set when none of the ids is dirty", () => {
      const { result } = renderDirty([A]);
      const before = result.current.dirtyBookIds;

      act(() => {
        result.current.clearDirtyIds([B]);
      });

      expect(result.current.dirtyBookIds).toBe(before);
    });
  });

  describe("moveRenamedDirty", () => {
    it("turns a dirty old id into its dirty new id", () => {
      const { result } = renderDirty([OLD_X, A]);

      act(() => {
        result.current.moveRenamedDirty([{ oldId: OLD_X, newId: NEW_Y }]);
      });

      expect([...result.current.dirtyBookIds].sort()).toEqual(
        [A, NEW_Y].sort(),
      );
      expect(result.current.dirtyRef.current.has(NEW_Y)).toBe(true);
    });

    it("keeps the same Set when no dirty id was renamed", () => {
      const { result } = renderDirty([A]);
      const before = result.current.dirtyBookIds;

      act(() => {
        result.current.moveRenamedDirty([{ oldId: OLD_X, newId: NEW_Y }]);
      });
      act(() => {
        result.current.moveRenamedDirty([]);
      });

      expect(result.current.dirtyBookIds).toBe(before);
    });
  });
});
