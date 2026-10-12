import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useBookSort } from "@/dialog/useBookSort";
import type { BookSortShelf } from "@/dialog/useBookSort";
import { FAMILY_SHELF_SORT_KEY, PERSONAL_SHELF_SORT_KEY } from "@/constants";

/**
 * The hook reads/writes each shelf's sort via DIRECT `browser.storage.local`
 * access (storage/bookSort.ts), not `browser.runtime.sendMessage` round-trips to
 * the background (issue #308). Firefox suspends the background event page, so the
 * old messaging path snapped a new sort back when the reply failed. The test mock
 * aliases `chrome.*` and `browser.*` to the same spies (see tests/setup.ts), so
 * mocking `chrome.storage.local.{get,set}` observes exactly what production calls.
 *
 * Each shelf has its own key (`FAMILY_SHELF_SORT_KEY` / `PERSONAL_SHELF_SORT_KEY`);
 * `seedSorts` answers a get for exactly the keys asked, so a read of the wrong key
 * comes back empty. Legacy stored `title`/`author` read as their `-asc` form and
 * anything unrecognized as "default". `setSort` writes fire-and-forget and NEVER
 * rolls the UI back on a storage failure; a mount read that resolves AFTER the user
 * already picked a sort must not overwrite that choice, while switching to the
 * other shelf must read that shelf's stored sort again.
 */

const KEY_FOR: Record<BookSortShelf, string> = {
  family: FAMILY_SHELF_SORT_KEY,
  personal: PERSONAL_SHELF_SORT_KEY,
};

const SHELVES: { shelf: BookSortShelf }[] = [
  { shelf: "family" },
  { shelf: "personal" },
];

/** Answer `storage.local.get(keys)` with only the requested entries of `store`. */
function seedSorts(store: Record<string, unknown>) {
  vi.mocked(chrome.storage.local.get).mockImplementation(((keys: unknown) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const result: Record<string, unknown> = {};
    for (const key of keyList) {
      if (typeof key === "string" && key in store) result[key] = store[key];
    }
    return Promise.resolve(result);
  }) as never);
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("useBookSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 'default' before the stored value resolves", async () => {
    seedSorts({ [FAMILY_SHELF_SORT_KEY]: "title-desc" });
    const { result } = renderHook(() => useBookSort("family"));
    expect(result.current.sort).toBe("default");
    // Settle the pending mount read inside act() to avoid a leaked update.
    await flushMicrotasks();
  });

  it.each(SHELVES)(
    "reads the '$shelf' shelf's own key from storage.local on mount",
    async ({ shelf }) => {
      const otherShelf: BookSortShelf =
        shelf === "family" ? "personal" : "family";
      seedSorts({
        [KEY_FOR[shelf]]: "title-desc",
        [KEY_FOR[otherShelf]]: "author-desc",
      });
      const { result } = renderHook(() => useBookSort(shelf));
      await waitFor(() => {
        expect(result.current.sort).toBe("title-desc");
      });
      expect(chrome.storage.local.get).toHaveBeenCalledWith([KEY_FOR[shelf]]);
      expect(chrome.storage.local.get).not.toHaveBeenCalledWith([
        KEY_FOR[otherShelf],
      ]);
    },
  );

  it.each(
    SHELVES.flatMap(({ shelf }) =>
      [
        { stored: "title", expected: "title-asc" },
        { stored: "author", expected: "author-asc" },
      ].map((row) => ({ shelf, ...row })),
    ),
  )(
    "normalizes legacy stored '$stored' to '$expected' on the '$shelf' shelf",
    async ({ shelf, stored, expected }) => {
      seedSorts({ [KEY_FOR[shelf]]: stored });
      const { result } = renderHook(() => useBookSort(shelf));
      await waitFor(() => {
        expect(result.current.sort).toBe(expected);
      });
    },
  );

  it.each([undefined, "bogus", "TITLE-ASC", "", 3, null, "__proto__"])(
    "normalizes the missing / unrecognized stored value %o to 'default'",
    async (stored) => {
      seedSorts(
        stored === undefined ? {} : { [FAMILY_SHELF_SORT_KEY]: stored },
      );
      const { result } = renderHook(() => useBookSort("family"));
      await flushMicrotasks();
      expect(chrome.storage.local.get).toHaveBeenCalledWith([
        FAMILY_SHELF_SORT_KEY,
      ]);
      expect(result.current.sort).toBe("default");
    },
  );

  it("keeps 'default' without throwing when the storage.local read rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );
    const { result } = renderHook(() => useBookSort("family"));
    await flushMicrotasks();
    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(result.current.sort).toBe("default");
  });

  it.each(SHELVES)(
    "updates state immediately and writes under the '$shelf' shelf's key",
    async ({ shelf }) => {
      const { result } = renderHook(() => useBookSort(shelf));
      await flushMicrotasks();

      act(() => {
        result.current.setSort("author-desc");
      });

      expect(result.current.sort).toBe("author-desc");
      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [KEY_FOR[shelf]]: "author-desc",
      });
    },
  );

  it.each(SHELVES)(
    "keeps the chosen sort on the '$shelf' shelf when the write rejects (no rollback)",
    async ({ shelf }) => {
      vi.mocked(chrome.storage.local.set).mockRejectedValue(
        new Error("storage write failed"),
      );
      const { result } = renderHook(() => useBookSort(shelf));
      await flushMicrotasks();
      expect(result.current.sort).toBe("default");

      act(() => {
        result.current.setSort("title-asc");
      });
      expect(result.current.sort).toBe("title-asc");

      // Flush the rejected write: the old hook snapped back to 'default' here.
      await flushMicrotasks();
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [KEY_FOR[shelf]]: "title-asc",
      });
      expect(result.current.sort).toBe("title-asc");
    },
  );

  it("does not write to storage.local when setting the current sort", async () => {
    seedSorts({ [FAMILY_SHELF_SORT_KEY]: "title-desc" });
    const { result } = renderHook(() => useBookSort("family"));
    await waitFor(() => {
      expect(result.current.sort).toBe("title-desc");
    });

    act(() => {
      result.current.setSort("title-desc");
    });

    expect(result.current.sort).toBe("title-desc");
    expect(chrome.storage.local.set).not.toHaveBeenCalled();

    // Positive companion: a different sort from the same state does write.
    act(() => {
      result.current.setSort("default");
    });
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [FAMILY_SHELF_SORT_KEY]: "default",
    });
  });

  it("keeps the user's choice when the mount read resolves after it", async () => {
    let resolveRead!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get).mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveRead = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useBookSort("personal"));

    act(() => {
      result.current.setSort("author-asc");
    });
    expect(result.current.sort).toBe("author-asc");

    await act(async () => {
      resolveRead({ [PERSONAL_SHELF_SORT_KEY]: "title-desc" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sort).toBe("author-asc");
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [PERSONAL_SHELF_SORT_KEY]: "author-asc",
    });
  });

  it("reads the new shelf's stored sort after a choice was made on the previous shelf", async () => {
    seedSorts({ [PERSONAL_SHELF_SORT_KEY]: "author-desc" });
    const { result, rerender } = renderHook(
      ({ shelf }: { shelf: BookSortShelf }) => useBookSort(shelf),
      { initialProps: { shelf: "family" } },
    );
    await flushMicrotasks();

    act(() => {
      result.current.setSort("title-asc");
    });
    expect(result.current.sort).toBe("title-asc");

    rerender({ shelf: "personal" });
    await waitFor(() => {
      expect(result.current.sort).toBe("author-desc");
    });
    expect(chrome.storage.local.get).toHaveBeenCalledWith([
      PERSONAL_SHELF_SORT_KEY,
    ]);
  });

  it("ignores the previous shelf's read when it resolves after a shelf switch", async () => {
    let resolveFamilyRead!: (value: Record<string, unknown>) => void;
    vi.mocked(chrome.storage.local.get)
      .mockReturnValueOnce(
        new Promise<Record<string, unknown>>((resolve) => {
          resolveFamilyRead = resolve;
        }) as never,
      )
      .mockResolvedValueOnce({
        [PERSONAL_SHELF_SORT_KEY]: "author-desc",
      } as never);
    const { result, rerender } = renderHook(
      ({ shelf }: { shelf: BookSortShelf }) => useBookSort(shelf),
      { initialProps: { shelf: "family" } },
    );

    rerender({ shelf: "personal" });
    await waitFor(() => {
      expect(result.current.sort).toBe("author-desc");
    });

    await act(async () => {
      resolveFamilyRead({ [FAMILY_SHELF_SORT_KEY]: "title-desc" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sort).toBe("author-desc");
  });

  it("never messages the background to read or write the sort", async () => {
    seedSorts({ [FAMILY_SHELF_SORT_KEY]: "title-desc" });
    const { result } = renderHook(() => useBookSort("family"));
    await waitFor(() => {
      expect(result.current.sort).toBe("title-desc");
    });

    act(() => {
      result.current.setSort("author-asc");
    });
    await flushMicrotasks();

    expect(chrome.storage.local.get).toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
