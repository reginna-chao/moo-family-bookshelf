import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useManualLendNotice } from "@/hooks/useManualLendNotice";
import { namespacedKey } from "@/hooks/useAuth";

const USER_ID = "test-user-123";
const STORAGE_SUFFIX = "manualLendNoticeDismissed";

describe("useManualLendNotice", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to isDismissed=false when localStorage has no value", () => {
    const { result } = renderHook(() => useManualLendNotice(USER_ID));
    expect(result.current.isDismissed).toBe(false);
  });

  it("reads isDismissed=true when localStorage flag is 'true'", () => {
    localStorage.setItem(namespacedKey(USER_ID, STORAGE_SUFFIX), "true");
    const { result } = renderHook(() => useManualLendNotice(USER_ID));
    expect(result.current.isDismissed).toBe(true);
  });

  it("treats any non-'true' value as not dismissed", () => {
    localStorage.setItem(namespacedKey(USER_ID, STORAGE_SUFFIX), "1");
    const { result } = renderHook(() => useManualLendNotice(USER_ID));
    expect(result.current.isDismissed).toBe(false);
  });

  it("sets isDismissed=true and writes 'true' to localStorage on dismiss", () => {
    const { result } = renderHook(() => useManualLendNotice(USER_ID));

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
    expect(
      localStorage.getItem(namespacedKey(USER_ID, STORAGE_SUFFIX)),
    ).toBe("true");
  });

  it("uses the correct namespaced key (moo:{userId}:manualLendNoticeDismissed)", () => {
    const { result } = renderHook(() => useManualLendNotice(USER_ID));

    act(() => {
      result.current.dismiss();
    });

    const expectedKey = `moo:${USER_ID}:manualLendNoticeDismissed`;
    expect(localStorage.getItem(expectedKey)).toBe("true");
  });

  it("re-reads the flag when userId changes", () => {
    const otherUserId = "other-user-456";
    localStorage.setItem(namespacedKey(USER_ID, STORAGE_SUFFIX), "true");

    const { result, rerender } = renderHook(
      ({ userId }) => useManualLendNotice(userId),
      { initialProps: { userId: USER_ID } },
    );
    expect(result.current.isDismissed).toBe(true);

    rerender({ userId: otherUserId });
    expect(result.current.isDismissed).toBe(false);
  });

  it("keeps each user's dismissal independent", () => {
    const { result } = renderHook(() => useManualLendNotice(USER_ID));

    act(() => {
      result.current.dismiss();
    });

    const otherUserId = "other-user-456";
    expect(
      localStorage.getItem(namespacedKey(otherUserId, STORAGE_SUFFIX)),
    ).toBeNull();
  });
});
