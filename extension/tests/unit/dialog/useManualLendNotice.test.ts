import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useManualLendNotice } from "@/dialog/useManualLendNotice";

const STORAGE_KEY = "manualLendNoticeDismissed";

describe("useManualLendNotice", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
  });

  it("defaults to isDismissed=false when nothing is stored", async () => {
    const { result } = renderHook(() => useManualLendNotice());

    // Initial render is false; the async read confirms it stays false.
    await waitFor(() => {
      expect(result.current.isDismissed).toBe(false);
    });
  });

  it("reads isDismissed=true from chrome.storage.local on mount", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: true });

    const { result } = renderHook(() => useManualLendNotice());

    await waitFor(() => {
      expect(result.current.isDismissed).toBe(true);
    });
  });

  it("sets isDismissed=true and persists to chrome.storage.local on dismiss", async () => {
    const { result } = renderHook(() => useManualLendNotice());

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.isDismissed).toBe(true);
    const stored = await chrome.storage.local.get([STORAGE_KEY]);
    expect(stored[STORAGE_KEY]).toBe(true);
  });

  it("treats a non-true stored value as not dismissed", async () => {
    await chrome.storage.local.set({ [STORAGE_KEY]: "true" });

    const { result } = renderHook(() => useManualLendNotice());

    // The hook only treats the boolean true as dismissed.
    await waitFor(() => {
      expect(result.current.isDismissed).toBe(false);
    });
  });
});
