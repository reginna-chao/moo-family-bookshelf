import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import browser from "webextension-polyfill";
import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { READMOO_STORE_MATCH_PATTERNS } from "moo-family-bookshelf-shared/config/readmooStore";
import {
  hasStoreHostPermission,
  reconcileStorePageScript,
  STORE_PAGE_SCRIPT_ID,
} from "@/background/storePageScript";
import {
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
} from "@/constants";

/**
 * reconcileStorePageScript (#313, src/background/storePageScript.ts): the background's only job for the
 * store-page chip. It registers `content-store.js` exactly while the switch is on AND the optional host
 * permission is granted, mirrors `permissions.contains` into storage for the Dialog, and clears the
 * index while the switch is off.
 *
 * Fake registry: `scripting.*` is backed by a Set, and `registerContentScripts` rejects a duplicate id
 * like the real API does. That is what makes the serialisation case meaningful: without the module's
 * promise chain two concurrent reconciles both see "not registered", both register, and the second one
 * throws (caught and warned), so `registerContentScripts` runs twice.
 *
 * Re-read before clearing: the reconcile reads the switch once at the start, and the Dialog can switch it
 * on and write a fresh index while the reconcile is awaiting the registry. Clearing on the stale read
 * would delete that index, so the reconcile reads the switch again right before clearing. The race is
 * staged by writing the switch + index from inside `getRegisteredContentScripts`, which runs between the
 * two reads.
 *
 * Two independent steps: aligning the registration and clearing the index each catch and warn on
 * their own (`reconcile failed` / `index clear failed`), so a permissions or scripting failure never
 * leaves an index behind while the switch is off, and a failed clear still resolves the reconcile.
 *
 * Storage runs against the store-backed mock in tests/setup.ts, cleared around every case.
 */

const INDEX = { version: 1, viewerUserId: "u", updatedAt: "t", books: {} };

let registry: Set<string>;
let betweenReads: (() => Promise<void>) | null;

function seed(items: Record<string, unknown>): Promise<void> {
  return chrome.storage.local.set(items);
}

async function stored(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(null);
}

function grant(on: boolean): void {
  vi.mocked(browser.permissions.contains).mockResolvedValue(on);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.local.clear();
  registry = new Set();
  betweenReads = null;
  grant(false);
  vi.mocked(browser.scripting.getRegisteredContentScripts).mockImplementation(
    (async (filter?: { ids?: string[] }) => {
      if (betweenReads) await betweenReads();
      return [...registry]
        .filter((id) => !filter?.ids || filter.ids.includes(id))
        .map((id) => ({ id }));
    }) as never,
  );
  vi.mocked(browser.scripting.registerContentScripts).mockImplementation(
    (async (scripts: { id: string }[]) => {
      // Let a concurrent reconcile interleave here, as the real async API would.
      await new Promise((r) => setTimeout(r, 0));
      for (const { id } of scripts) {
        if (registry.has(id)) throw new Error(`Duplicate script ID '${id}'`);
        registry.add(id);
      }
    }) as never,
  );
  vi.mocked(browser.scripting.unregisterContentScripts).mockImplementation(
    (async (filter?: { ids?: string[] }) => {
      for (const id of filter?.ids ?? []) registry.delete(id);
    }) as never,
  );
});

afterEach(async () => {
  await chrome.storage.local.clear();
});

describe("hasStoreHostPermission", () => {
  it("asks for exactly the store book-page pattern", async () => {
    grant(true);

    await expect(hasStoreHostPermission()).resolves.toBe(true);
    expect(browser.permissions.contains).toHaveBeenCalledWith({
      origins: [...READMOO_STORE_MATCH_PATTERNS],
    });
  });
});

describe("reconcileStorePageScript", () => {
  it("registers the store-page script when the switch is on and the permission granted", async () => {
    grant(true);
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      [STORE_PAGE_INDEX_KEY]: INDEX,
    });

    await reconcileStorePageScript();

    expect(browser.scripting.registerContentScripts).toHaveBeenCalledWith([
      {
        id: STORE_PAGE_SCRIPT_ID,
        matches: [...READMOO_STORE_MATCH_PATTERNS],
        js: ["content-store.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
    expect(registry.has(STORE_PAGE_SCRIPT_ID)).toBe(true);
    const local = await stored();
    expect(local[STORE_PAGE_HOST_GRANTED_KEY]).toBe(BoolFlag.TRUE);
    expect(local[STORE_PAGE_INDEX_KEY]).toEqual(INDEX);
  });

  it.each<[string, boolean, BoolFlag, BoolFlag, boolean]>([
    // name, granted, switch, expected mirror, index kept
    ["granted but switched off", true, BoolFlag.FALSE, BoolFlag.TRUE, false],
    ["switched on but not granted", false, BoolFlag.TRUE, BoolFlag.FALSE, true],
    ["neither", false, BoolFlag.FALSE, BoolFlag.FALSE, false],
  ])(
    "registers nothing when %s",
    async (_name, granted, flag, mirror, indexKept) => {
      grant(granted);
      await seed({
        [STORE_PAGE_CHIP_ENABLED_KEY]: flag,
        [STORE_PAGE_INDEX_KEY]: INDEX,
      });

      await reconcileStorePageScript();

      expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();
      expect(registry.size).toBe(0);
      const local = await stored();
      expect(local[STORE_PAGE_HOST_GRANTED_KEY]).toBe(mirror);
      // The index exists only while the switch is on.
      expect(Object.hasOwn(local, STORE_PAGE_INDEX_KEY)).toBe(indexKept);
    },
  );

  it("clears the index when the switch was never set", async () => {
    grant(true);
    await seed({ [STORE_PAGE_INDEX_KEY]: INDEX });

    await reconcileStorePageScript();

    expect(await stored()).not.toHaveProperty(STORE_PAGE_INDEX_KEY);
  });

  it("does not register again when the script is already registered", async () => {
    grant(true);
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });

    await reconcileStorePageScript();
    await reconcileStorePageScript();

    expect(browser.scripting.registerContentScripts).toHaveBeenCalledOnce();
    expect(browser.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it.each<[string, boolean, BoolFlag]>([
    ["the switch goes off", true, BoolFlag.FALSE],
    ["the permission is revoked", false, BoolFlag.TRUE],
  ])("unregisters the script when %s", async (_name, granted, flag) => {
    registry.add(STORE_PAGE_SCRIPT_ID);
    grant(granted);
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: flag });

    await reconcileStorePageScript();

    expect(browser.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: [STORE_PAGE_SCRIPT_ID],
    });
    expect(registry.size).toBe(0);
  });

  // See the header → "Re-read before clearing".
  it("keeps an index the Dialog wrote after switching on mid-reconcile", async () => {
    grant(true);
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE });
    betweenReads = async () => {
      betweenReads = null;
      await seed({
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
        [STORE_PAGE_INDEX_KEY]: INDEX,
      });
    };

    await reconcileStorePageScript();

    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    expect((await stored())[STORE_PAGE_INDEX_KEY]).toEqual(INDEX);
  });

  // See the header → "Fake registry".
  it("runs concurrent reconciles one at a time, registering once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    grant(true);
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });

    try {
      await Promise.all([
        reconcileStorePageScript(),
        reconcileStorePageScript(),
      ]);

      expect(browser.scripting.registerContentScripts).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each<[string, () => void]>([
    [
      "rejects",
      () =>
        vi
          .mocked(browser.permissions.contains)
          .mockRejectedValueOnce(new Error("no permissions API")),
    ],
    [
      "throws synchronously",
      () =>
        vi.mocked(browser.permissions.contains).mockImplementationOnce(() => {
          throw new Error("context invalidated");
        }),
    ],
  ])(
    "resolves and only warns when permissions.contains %s",
    async (_name, breakContains) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      grant(true);
      await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });
      breakContains();

      try {
        await expect(reconcileStorePageScript()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
        expect(browser.scripting.registerContentScripts).not.toHaveBeenCalled();

        // The chain is not poisoned: the next event reconciles normally.
        await reconcileStorePageScript();
        expect(registry.has(STORE_PAGE_SCRIPT_ID)).toBe(true);
      } finally {
        warn.mockRestore();
      }
    },
  );

  // See the header → "Two independent steps".
  it("still clears the index while off when permissions.contains rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE,
      [STORE_PAGE_INDEX_KEY]: INDEX,
    });
    vi.mocked(browser.permissions.contains).mockRejectedValueOnce(
      new Error("no permissions API"),
    );

    try {
      await expect(reconcileStorePageScript()).resolves.toBeUndefined();

      expect(await stored()).not.toHaveProperty(STORE_PAGE_INDEX_KEY);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "[storePageScript] reconcile failed",
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves and warns when clearing the index fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    grant(true);
    await seed({
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE,
      [STORE_PAGE_INDEX_KEY]: INDEX,
    });
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
      new Error("quota"),
    );

    try {
      await expect(reconcileStorePageScript()).resolves.toBeUndefined();

      expect(chrome.storage.local.remove).toHaveBeenCalledWith(
        STORE_PAGE_INDEX_KEY,
      );
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "[storePageScript] index clear failed",
        expect.any(Error),
      );
      // The registration step before it ran to completion.
      expect((await stored())[STORE_PAGE_HOST_GRANTED_KEY]).toBe(BoolFlag.TRUE);

      // The chain is not poisoned: the next event clears the index.
      await reconcileStorePageScript();
      expect(await stored()).not.toHaveProperty(STORE_PAGE_INDEX_KEY);
    } finally {
      warn.mockRestore();
    }
  });

  it("resolves when registering fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    grant(true);
    await seed({ [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE });
    vi.mocked(browser.scripting.registerContentScripts).mockRejectedValueOnce(
      new Error("bad pattern"),
    );

    try {
      await expect(reconcileStorePageScript()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
