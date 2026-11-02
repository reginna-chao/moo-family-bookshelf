import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import {
  buildStorePageIndex,
  type StoreIndexMember,
} from "moo-family-bookshelf-shared/storePage/index";
import {
  clearStorePageIndex,
  readStorePageChipEnabled,
  readStorePageHostGranted,
  readStorePageIndex,
  updateStorePageIndexIfEnabled,
  writeStorePageChipEnabled,
  writeStorePageHostGranted,
  writeStorePageIndex,
} from "@/storage/storePageChip";
import {
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
} from "@/constants";

/**
 * Store-page chip storage (#313, src/storage/storePageChip.ts): three storage.local keys read and
 * written directly (never through the background). Runs against the store-backed mock in
 * tests/setup.ts, cleared around every case, so reads observe what writes actually stored.
 *
 * Flags follow the BoolFlag convention: only an exact `BoolFlag.TRUE` reads as on. The index exists only
 * while the switch is on, so `updateStorePageIndexIfEnabled` (called after every successful family-shelf
 * load) writes nothing with the switch off; it is fire-and-forget from the Dialog, so it never rejects.
 */

const VIEWER = "viewer-user-id";
const BOOK_A = "210000000000001";
const NOW = new Date("2026-11-02T00:00:00.000Z");

const MEMBERS: StoreIndexMember[] = [
  { userId: VIEWER, displayName: "Me", books: [{ bookId: BOOK_A }] },
  { userId: "user-2", displayName: "Bob", books: [{ bookId: BOOK_A }] },
];

async function stored(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(null);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await chrome.storage.local.clear();
});

describe.each([
  [
    "readStorePageChipEnabled",
    readStorePageChipEnabled,
    STORE_PAGE_CHIP_ENABLED_KEY,
  ],
  [
    "readStorePageHostGranted",
    readStorePageHostGranted,
    STORE_PAGE_HOST_GRANTED_KEY,
  ],
])("%s", (_name, read, key) => {
  it.each<[unknown, BoolFlag]>([
    [BoolFlag.TRUE, BoolFlag.TRUE],
    [BoolFlag.FALSE, BoolFlag.FALSE],
    [true, BoolFlag.FALSE],
    ["1", BoolFlag.FALSE],
    [2, BoolFlag.FALSE],
    [null, BoolFlag.FALSE],
  ])("reads a stored %j as %s", async (value, expected) => {
    await chrome.storage.local.set({ [key]: value });

    expect(await read()).toBe(expected);
  });

  it("reads a missing key as FALSE", async () => {
    expect(await read()).toBe(BoolFlag.FALSE);
  });
});

describe.each([
  [
    "writeStorePageChipEnabled",
    writeStorePageChipEnabled,
    STORE_PAGE_CHIP_ENABLED_KEY,
  ],
  [
    "writeStorePageHostGranted",
    writeStorePageHostGranted,
    STORE_PAGE_HOST_GRANTED_KEY,
  ],
])("%s", (_name, write, key) => {
  it.each([BoolFlag.TRUE, BoolFlag.FALSE])(
    "stores %s under its own key",
    async (flag) => {
      await write(flag);

      expect(await stored()).toEqual({ [key]: flag });
    },
  );
});

describe("store-page index", () => {
  it("reads back the index it wrote", async () => {
    const index = buildStorePageIndex(MEMBERS, VIEWER, NOW);

    await writeStorePageIndex(index);

    expect(await readStorePageIndex()).toEqual(index);
  });

  it("reads a missing index as null", async () => {
    expect(await readStorePageIndex()).toBeNull();
  });

  it("reads a malformed index as null", async () => {
    await chrome.storage.local.set({
      [STORE_PAGE_INDEX_KEY]: { version: 1, viewerUserId: VIEWER, books: {} },
    });

    expect(await readStorePageIndex()).toBeNull();
  });

  it("clears the index and nothing else", async () => {
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [STORE_PAGE_INDEX_KEY]: buildStorePageIndex(MEMBERS, VIEWER, NOW),
    });

    await clearStorePageIndex();

    expect(await stored()).toEqual({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
  });
});

describe("updateStorePageIndexIfEnabled", () => {
  it("writes the index built from the members, without the viewer, when the switch is on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });

    await updateStorePageIndexIfEnabled(MEMBERS, VIEWER);

    const index = (await stored())[STORE_PAGE_INDEX_KEY];
    expect(index).toEqual(buildStorePageIndex(MEMBERS, VIEWER, NOW));
    expect(index).toEqual(
      expect.objectContaining({ books: { [BOOK_A]: ["Bob"] } }),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    ["off", { [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE }],
    ["never set", {}],
    ["a raw true", { [STORE_PAGE_CHIP_ENABLED_KEY]: true }],
  ])("writes nothing when the switch is %s", async (_name, seed) => {
    await chrome.storage.local.set(seed);
    vi.mocked(chrome.storage.local.set).mockClear();

    await updateStorePageIndexIfEnabled(MEMBERS, VIEWER);

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(await stored()).not.toHaveProperty(STORE_PAGE_INDEX_KEY);
  });

  it("resolves and only warns when the switch read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("context invalidated"),
    );

    await expect(
      updateStorePageIndexIfEnabled(MEMBERS, VIEWER),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("resolves and only warns when the index write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
    });
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("quota"),
    );

    await expect(
      updateStorePageIndexIfEnabled(MEMBERS, VIEWER),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });
});
