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
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "@/constants";

/**
 * Store-page chip storage (#313, src/storage/storePageChip.ts): three storage.local keys read and
 * written directly (never through the background). Runs against the store-backed mock in
 * tests/setup.ts, cleared around every case, so reads observe what writes actually stored.
 *
 * Flags follow the BoolFlag convention: only an exact `BoolFlag.TRUE` reads as on. The index exists only
 * while the switch is on, so `updateStorePageIndexIfEnabled` (called after every successful family-shelf
 * load) writes nothing with the switch off; it is fire-and-forget from the Dialog, so it never rejects.
 * It also writes nothing once the stored userId / familyId no longer name the viewer and the family the
 * shelf was loaded for: the request can outlive a leave or an account reset, and a late write would
 * resurrect an index for a family the user already left.
 */

const VIEWER = "viewer-user-id";
const FAMILY = "family-id-1";
const BOOK_A = "210000000000001";
const NOW = new Date("2026-11-02T00:00:00.000Z");

const MEMBERS: StoreIndexMember[] = [
  { userId: VIEWER, displayName: "Me", books: [{ bookId: BOOK_A }] },
  { userId: "user-2", displayName: "Bob", books: [{ bookId: BOOK_A }] },
];

const ENABLED_AND_BOUND = {
  [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
  [USER_ID_KEY]: VIEWER,
  [FAMILY_ID_KEY]: FAMILY,
};

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
    const index = buildStorePageIndex(MEMBERS, VIEWER, FAMILY, NOW);

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

  it("reads a well-formed version-1 index (no familyId) as null", async () => {
    await chrome.storage.local.set({
      [STORE_PAGE_INDEX_KEY]: {
        version: 1,
        viewerUserId: VIEWER,
        updatedAt: NOW.toISOString(),
        books: { [BOOK_A]: ["Bob"] },
      },
    });

    expect(await readStorePageIndex()).toBeNull();
  });

  it("clears the index and nothing else", async () => {
    await chrome.storage.local.set({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [STORE_PAGE_INDEX_KEY]: buildStorePageIndex(MEMBERS, VIEWER, FAMILY, NOW),
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
    await chrome.storage.local.set(ENABLED_AND_BOUND);

    await updateStorePageIndexIfEnabled(MEMBERS, VIEWER, FAMILY);

    const index = (await stored())[STORE_PAGE_INDEX_KEY];
    expect(index).toEqual(buildStorePageIndex(MEMBERS, VIEWER, FAMILY, NOW));
    expect(index).toEqual(
      expect.objectContaining({
        familyId: FAMILY,
        books: { [BOOK_A]: ["Bob"] },
      }),
    );
  });

  it("reads the switch and the binding in one storage call", async () => {
    await chrome.storage.local.set(ENABLED_AND_BOUND);
    vi.mocked(chrome.storage.local.get).mockClear();

    await updateStorePageIndexIfEnabled(MEMBERS, VIEWER, FAMILY);

    expect(chrome.storage.local.get).toHaveBeenCalledOnce();
    const [keys] = vi.mocked(chrome.storage.local.get).mock.calls[0];
    expect([...(keys as string[])].sort()).toEqual(
      [STORE_PAGE_CHIP_ENABLED_KEY, USER_ID_KEY, FAMILY_ID_KEY].sort(),
    );
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "the switch is off",
      { ...ENABLED_AND_BOUND, [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE },
    ],
    [
      "the switch was never set",
      { [USER_ID_KEY]: VIEWER, [FAMILY_ID_KEY]: FAMILY },
    ],
    [
      "the switch is a raw true",
      { ...ENABLED_AND_BOUND, [STORE_PAGE_CHIP_ENABLED_KEY]: true },
    ],
    [
      "the stored userId names another user",
      { ...ENABLED_AND_BOUND, [USER_ID_KEY]: "other-user-id" },
    ],
    [
      "the stored userId is gone",
      {
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
        [FAMILY_ID_KEY]: FAMILY,
      },
    ],
    [
      "the stored familyId names another family",
      { ...ENABLED_AND_BOUND, [FAMILY_ID_KEY]: "family-id-2" },
    ],
    [
      "the stored familyId is gone (left / unbound)",
      { [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE, [USER_ID_KEY]: VIEWER },
    ],
  ])("writes nothing when %s", async (_name, seed) => {
    await chrome.storage.local.set(seed);
    vi.mocked(chrome.storage.local.set).mockClear();

    await updateStorePageIndexIfEnabled(MEMBERS, VIEWER, FAMILY);

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(await stored()).not.toHaveProperty(STORE_PAGE_INDEX_KEY);
  });

  it("resolves and only warns when the switch read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
      new Error("context invalidated"),
    );

    await expect(
      updateStorePageIndexIfEnabled(MEMBERS, VIEWER, FAMILY),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("resolves and only warns when the index write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await chrome.storage.local.set(ENABLED_AND_BOUND);
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("quota"),
    );

    await expect(
      updateStorePageIndexIfEnabled(MEMBERS, VIEWER, FAMILY),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
  });
});
