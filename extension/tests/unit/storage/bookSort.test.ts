import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readBookSort, writeBookSort } from "@/storage/bookSort";
import type { BookSortShelf } from "@/storage/bookSort";
import { FAMILY_SHELF_SORT_KEY, PERSONAL_SHELF_SORT_KEY } from "@/constants";

/**
 * `readBookSort(shelf)` / `writeBookSort(shelf, mode)` are the data-access layer for
 * the family / personal shelf sort. They talk to `browser.storage.local` directly
 * (aliased to `chrome.storage.local` in tests/setup.ts), never to the background
 * (issue #308). Each shelf has its own key. Reads go through the shared
 * `normalizeSortMode`: canonical modes pass through, the legacy `title`/`author`
 * read as their `-asc` form, and anything else reads as "default".
 */

const SHELF_KEYS: [BookSortShelf, string][] = [
  ["family", FAMILY_SHELF_SORT_KEY],
  ["personal", PERSONAL_SHELF_SORT_KEY],
];

const CANONICAL_MODES = [
  "default",
  "title-asc",
  "title-desc",
  "author-asc",
  "author-desc",
] as const;

describe("readBookSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(SHELF_KEYS)(
    "reads the '%s' shelf from its own key %s",
    async (shelf, key) => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({
        [key]: "author-desc",
      } as never);

      const result = await readBookSort(shelf);

      expect(result).toBe("author-desc");
      expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.get).toHaveBeenCalledWith([key]);
    },
  );

  it.each<[unknown, string]>([
    ...CANONICAL_MODES.map((mode): [unknown, string] => [mode, mode]),
    ["title", "title-asc"], // legacy alias
    ["author", "author-asc"], // legacy alias
    [undefined, "default"], // key missing from the store
    ["bogus", "default"], // unknown string
    ["Title-Asc", "default"], // case-sensitive
    ["", "default"], // empty string
    ["__proto__", "default"], // prototype key is not an alias
    [1, "default"], // wrong type: number
    [null, "default"], // wrong type: null
  ])("returns stored %o normalized to '%s'", async (stored, expected) => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue(
      (stored === undefined
        ? {}
        : { [FAMILY_SHELF_SORT_KEY]: stored }) as never,
    );

    const result = await readBookSort("family");

    expect(result).toBe(expected);
  });

  it("ignores the other shelf's stored value", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation(((keys: unknown) =>
      Promise.resolve(
        Array.isArray(keys) && keys.includes(FAMILY_SHELF_SORT_KEY)
          ? { [FAMILY_SHELF_SORT_KEY]: "title-desc" }
          : {},
      )) as never);

    await expect(readBookSort("personal")).resolves.toBe("default");
    await expect(readBookSort("family")).resolves.toBe("title-desc");
  });

  it("propagates the rejection when storage.local.get rejects", async () => {
    vi.mocked(chrome.storage.local.get).mockRejectedValue(
      new Error("storage.local unavailable"),
    );

    await expect(readBookSort("family")).rejects.toThrow(
      "storage.local unavailable",
    );
  });
});

describe("writeBookSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.set).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(
    SHELF_KEYS.flatMap(([shelf, key]) =>
      CANONICAL_MODES.map((mode) => ({ shelf, key, mode })),
    ),
  )(
    "writes '$mode' for the '$shelf' shelf under its own key to storage.local only",
    async ({ shelf, key, mode }) => {
      await writeBookSort(shelf, mode);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({ [key]: mode });
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("propagates the rejection when storage.local.set rejects", async () => {
    vi.mocked(chrome.storage.local.set).mockRejectedValue(
      new Error("storage write failed"),
    );

    await expect(writeBookSort("personal", "title-asc")).rejects.toThrow(
      "storage write failed",
    );
  });
});
