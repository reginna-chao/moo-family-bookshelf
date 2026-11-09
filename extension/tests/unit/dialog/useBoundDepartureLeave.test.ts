import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { API_ENDPOINT_KEY, FAMILY_ID_KEY, USER_ID_KEY } from "@/constants";
import { useBoundDepartureLeave } from "@/dialog/useBoundDepartureLeave";

/**
 * useBoundDepartureLeave — the `onLeave` FamilySettings hands its leave block. A leave that succeeds
 * clears the local family binding through `onLeave`; by the time the response lands, another tab may
 * have bound storage to another family or account, and that binding is not this leave's to clear.
 * The wrapper skips `onLeave` only when storage now binds ANOTHER account or family; a family binding
 * another tab already cleared (same or no userId left) still calls it, the stored server is not
 * compared, and a storage read that throws still calls it.
 *
 * The leave hook keeps the callback from the render where the user confirmed, so a callback taken
 * from an earlier render compares that render's account and family, not the latest props.
 *
 * The check is asynchronous (one storage read), so every call runs inside `act` and is awaited
 * through `settle()` before asserting on `onLeave`.
 */

const BOUND = { [USER_ID_KEY]: "user-1", [FAMILY_ID_KEY]: "fam-1" };

function setup(props = { userId: "user-1", familyId: "fam-1" }) {
  const onLeave = vi.fn();
  const hook = renderHook(
    (p: { userId: string; familyId: string }) =>
      useBoundDepartureLeave({ ...p, onLeave }),
    { initialProps: props },
  );
  return { hook, onLeave };
}

/** Run `leave` and let its storage read settle (a macrotask drains the read's promise chain). */
async function settle(leave: () => void): Promise<void> {
  await act(async () => {
    leave();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useBoundDepartureLeave", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  it.each<[string, Record<string, unknown>]>([
    ["storage still holds the same account and family", BOUND],
    [
      "only the stored server changed",
      { ...BOUND, [API_ENDPOINT_KEY]: "https://self-hosted.example" },
    ],
    ["another tab already cleared the family", { [USER_ID_KEY]: "user-1" }],
    ["another tab already cleared everything", {}],
  ])("calls onLeave once when %s", async (_label, stored) => {
    await chrome.storage.local.set(stored);
    const { hook, onLeave } = setup();

    await settle(hook.result.current);

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Record<string, unknown>]>([
    ["another family", { ...BOUND, [FAMILY_ID_KEY]: "fam-2" }],
    ["another account", { ...BOUND, [USER_ID_KEY]: "user-2" }],
    ["no family under another account", { [USER_ID_KEY]: "user-2" }],
  ])(
    "does not call onLeave when storage now holds %s",
    async (_label, stored) => {
      await chrome.storage.local.set(stored);
      const { hook, onLeave } = setup();

      await settle(hook.result.current);

      // Positive companion: the check did read the binding keys before deciding.
      expect(chrome.storage.local.get).toHaveBeenCalledWith([
        USER_ID_KEY,
        FAMILY_ID_KEY,
      ]);
      expect(onLeave).not.toHaveBeenCalled();
      // The other binding is left exactly as it was.
      expect(await chrome.storage.local.get(null)).toEqual(stored);
    },
  );

  it("calls onLeave when the storage read rejects", async () => {
    await chrome.storage.local.set({ ...BOUND, [FAMILY_ID_KEY]: "fam-2" });
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("Extension context invalidated"),
    );
    const { hook, onLeave } = setup();

    await settle(hook.result.current);

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("compares the account and family of the render the callback came from", async () => {
    await chrome.storage.local.set({ ...BOUND, [FAMILY_ID_KEY]: "fam-2" });
    const { hook, onLeave } = setup();
    const confirmedOnFam1 = hook.result.current;

    hook.rerender({ userId: "user-1", familyId: "fam-2" });
    await settle(confirmedOnFam1);
    expect(onLeave).not.toHaveBeenCalled();

    // Positive companion: the latest render's callback matches storage and leaves.
    await settle(hook.result.current);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
