import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { BoolFlag, type ApiClient, type BookEntry } from "@/api/client";

// The save refreshes the aggregated family shelf through the FamilyData
// context; isolate the hook from it (same approach as PersonalShelfPage.test).
const mockRefreshBookshelf = vi.fn(async () => {});
vi.mock("@/hooks/useFamilyData", () => ({
  useFamilyData: () => ({ refreshBookshelf: mockRefreshBookshelf }),
}));

import { usePersonalShelfEditor } from "@/hooks/usePersonalShelfEditor";

/**
 * #250: a share change made while a save is in flight used to lose its unsaved
 * mark when that save succeeded — the success path cleared the WHOLE dirty set,
 * so the page showed the new flag with nothing to save while the server held
 * the sent one. Only the ids the save really saved may be cleared now.
 *
 * Each case holds the save's PATCH open, edits mid-flight, then releases it.
 * The 1500ms saved→ready timer is cleared by RTL's unmount.
 */

const A = "book-a";
const B = "book-b";
const C = "book-c";

const makeBook = (bookId: string, isShared: BoolFlag): BookEntry => ({
  bookId,
  title: `書-${bookId}`,
  author: "",
  isbn: "",
  coverUrl: "",
  readmooUrl: "",
  category: "",
  isShared,
});

function flagsOf(books: readonly BookEntry[]): Array<[string, BoolFlag]> {
  return books.map((b) => [b.bookId, b.isShared]);
}

/** A PATCH whose FIRST call stays pending until `release()`; later calls succeed. */
function heldPatch() {
  let resolveFirst: ((value: unknown) => void) | undefined;
  const patch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue({ data: { ok: true, applied: 1 } });
  return {
    patch,
    release: () => resolveFirst?.({ data: { ok: true, applied: 1 } }),
  };
}

/** Server holds A (not shared), B (shared), C (not shared). */
async function renderHeld() {
  const { patch, release } = heldPatch();
  const apiClient = {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: {
        schemaVersion: 1,
        userId: "user-1",
        displayName: "小明",
        books: [
          makeBook(A, BoolFlag.FALSE),
          makeBook(B, BoolFlag.TRUE),
          makeBook(C, BoolFlag.FALSE),
        ],
        lastUpdated: "2026-01-01T00:00:00.000Z",
      },
    }),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
    patchPersonalBooks: patch,
  } as unknown as ApiClient;
  const hook = renderHook(() => usePersonalShelfEditor("user-1", apiClient));
  await waitFor(() => expect(hook.result.current.state).toBe("ready"));
  return { ...hook, apiClient, patch, release };
}

type Hook = Awaited<ReturnType<typeof renderHeld>>;

/** Start a save and leave it in flight (the promise is returned wrapped). */
async function startSave(
  result: Hook["result"],
): Promise<{ pending: Promise<void> }> {
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.handleSave();
  });
  expect(result.current.state).toBe("saving");
  return { pending };
}

async function finishSave(hook: Hook, pending: Promise<void>) {
  await act(async () => {
    hook.release();
    await pending;
  });
  expect(hook.result.current.state).toBe("saved");
}

/** Share A, save (held open), un-share A mid-save, let the save succeed. */
async function shareAThenRevertMidSave() {
  const hook = await renderHeld();
  act(() => {
    hook.result.current.handleToggle(A);
  });
  const { pending } = await startSave(hook.result);
  expect(hook.patch.mock.calls[0][1]).toEqual([
    { bookId: A, isShared: BoolFlag.TRUE },
  ]);

  act(() => {
    hook.result.current.handleToggle(A);
  });
  await finishSave(hook, pending);
  return hook;
}

describe("usePersonalShelfEditor — a share change made while a save is in flight (#250)", () => {
  beforeEach(() => {
    mockRefreshBookshelf.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps a book reverted mid-save unsaved, then saves the revert on the next save", async () => {
    const hook = await shareAThenRevertMidSave();
    const { result, patch, apiClient } = hook;

    expect(result.current.books.find((b) => b.bookId === A)?.isShared).toBe(
      BoolFlag.FALSE,
    );
    expect([...result.current.dirtyBookIds]).toEqual([A]);
    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(apiClient.updatePersonalBooks).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: A, isShared: BoolFlag.FALSE },
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("restores the server's share on Cancel after a mid-save revert", async () => {
    const { result } = await shareAThenRevertMidSave();

    act(() => {
      result.current.handleCancelChanges();
    });

    expect(flagsOf(result.current.books)).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.TRUE],
      [C, BoolFlag.FALSE],
    ]);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyBookIds.size).toBe(0);
  });

  it("keeps another book toggled mid-save unsaved and clears the one that was sent", async () => {
    const hook = await renderHeld();
    const { result, patch } = hook;
    act(() => {
      result.current.handleToggle(A);
    });
    const { pending } = await startSave(result);

    act(() => {
      result.current.handleToggle(C);
    });
    await finishSave(hook, pending);

    expect([...result.current.dirtyBookIds]).toEqual([C]);
    expect(result.current.isDirty).toBe(true);
    expect(flagsOf(result.current.books)).toEqual([
      [A, BoolFlag.TRUE],
      [B, BoolFlag.TRUE],
      [C, BoolFlag.TRUE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: C, isShared: BoolFlag.TRUE },
    ]);
  });

  it("keeps a batch hide made mid-save unsaved", async () => {
    const hook = await renderHeld();
    const { result, patch } = hook;
    act(() => {
      result.current.handleToggle(A);
    });
    const { pending } = await startSave(result);

    act(() => {
      result.current.setSelectedIds(new Set([A, B]));
    });
    act(() => {
      result.current.handleBatchHide();
    });
    await finishSave(hook, pending);

    expect([...result.current.dirtyBookIds].sort()).toEqual([A, B].sort());
    expect(flagsOf(result.current.books)).toEqual([
      [A, BoolFlag.FALSE],
      [B, BoolFlag.FALSE],
      [C, BoolFlag.FALSE],
    ]);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(patch.mock.calls[1][1]).toEqual([
      { bookId: A, isShared: BoolFlag.FALSE },
      { bookId: B, isShared: BoolFlag.FALSE },
    ]);
  });

  it("clears every sent id when nothing changed during the save", async () => {
    const hook = await renderHeld();
    const { result } = hook;
    act(() => {
      result.current.handleToggle(A);
      result.current.handleToggle(C);
    });
    const { pending } = await startSave(result);

    await finishSave(hook, pending);

    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(mockRefreshBookshelf).toHaveBeenCalledTimes(1);
  });

  it("clears a book toggled twice mid-save (back to the value that was sent)", async () => {
    const hook = await renderHeld();
    const { result, patch } = hook;
    act(() => {
      result.current.handleToggle(A);
    });
    const { pending } = await startSave(result);

    act(() => {
      result.current.handleToggle(A);
    });
    act(() => {
      result.current.handleToggle(A);
    });
    await finishSave(hook, pending);

    expect(result.current.books.find((b) => b.bookId === A)?.isShared).toBe(
      BoolFlag.TRUE,
    );
    expect(result.current.dirtyBookIds.size).toBe(0);
    expect(result.current.isDirty).toBe(false);
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
