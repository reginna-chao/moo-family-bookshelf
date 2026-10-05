import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { migratePersonalBooksCache } from "@/dialog/personalBooksCacheMigration";
import { migratePersonalBooksCache as reExported } from "@/dialog/onboardingFlow";
import { BoolFlag, type ApiClient } from "@/api/client";
import { DISPLAY_NAME_KEY, PERSONAL_BOOKS_CACHE_KEY } from "@/constants";
import { encodePersonalBooksCache } from "@/dialog/personalBooksCache";

/**
 * #236: the cache is uploaded ONLY when the server holds no record. An existing
 * record is authoritative (the cache may hold ids the server has replaced), and
 * a failed check must neither upload nor discard the cache.
 *
 * #272 (P0 privacy): the cache is uploaded ONLY for the account that owns it.
 * Account A's cache left in the browser profile must never become account B's
 * shelf when B onboards; a cache with another owner, or in the legacy ownerless
 * bare-array format, is deleted without asking or writing to the server.
 */

const USER_ID = "user-abc";
const OTHER_USER_ID = "user-xyz";
const CACHED = [
  {
    bookId: "210000000000001",
    title: "快取書",
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  },
];

function makeApi(getResponse: unknown | Error): ApiClient {
  return {
    getPersonalBooks:
      getResponse instanceof Error
        ? vi.fn().mockRejectedValue(getResponse)
        : vi.fn().mockResolvedValue(getResponse),
    updatePersonalBooks: vi.fn().mockResolvedValue({ data: { ok: true } }),
  } as unknown as ApiClient;
}

async function cacheStillThere(): Promise<boolean> {
  const stored = await chrome.storage.local.get([PERSONAL_BOOKS_CACHE_KEY]);
  return PERSONAL_BOOKS_CACHE_KEY in stored;
}

describe("migratePersonalBooksCache", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [PERSONAL_BOOKS_CACHE_KEY]: encodePersonalBooksCache(USER_ID, CACHED),
      [DISPLAY_NAME_KEY]: "小明",
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await chrome.storage.local.clear();
  });

  it("is still re-exported from onboardingFlow", () => {
    expect(reExported).toBe(migratePersonalBooksCache);
  });

  it.each([
    { name: "data: null", response: { data: null } },
    { name: "no data field", response: {} },
  ])(
    "uploads the cache and removes it when the server has no record ($name)",
    async ({ response }) => {
      const api = makeApi(response);

      await migratePersonalBooksCache(USER_ID, api);

      expect(api.getPersonalBooks).toHaveBeenCalledWith(USER_ID);
      expect(api.updatePersonalBooks).toHaveBeenCalledTimes(1);
      expect(api.updatePersonalBooks).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          userId: USER_ID,
          displayName: "小明",
          books: CACHED,
        }),
      );
      expect(await cacheStillThere()).toBe(false);
    },
  );

  it("does not upload over an existing record, and discards the cache", async () => {
    const api = makeApi({ data: { books: [] } });

    await migratePersonalBooksCache(USER_ID, api);

    expect(api.updatePersonalBooks).not.toHaveBeenCalled();
    expect(await cacheStillThere()).toBe(false);
  });

  it.each([
    {
      name: "returns an error",
      response: { error: { code: "INTERNAL_ERROR", message: "x" } },
    },
    { name: "throws", response: new Error("network down") },
  ])(
    "neither uploads nor discards the cache when the server check $name",
    async ({ response }) => {
      const api = makeApi(response);

      await migratePersonalBooksCache(USER_ID, api);

      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(await cacheStillThere()).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    },
  );

  describe("a cache that is not the onboarding account's (#272)", () => {
    it("uploads the cache for the account that owns it (positive companion)", async () => {
      const api = makeApi({ data: null });

      await migratePersonalBooksCache(USER_ID, api);

      expect(api.updatePersonalBooks).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ userId: USER_ID, books: CACHED }),
      );
    });

    it("never uploads another account's cache, and deletes it", async () => {
      // Server answers "no record" — the exact state in which a cache is uploaded.
      const api = makeApi({ data: null });

      await migratePersonalBooksCache(OTHER_USER_ID, api);

      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(api.getPersonalBooks).not.toHaveBeenCalled();
      expect(await cacheStillThere()).toBe(false);
    });

    it.each([
      { name: "the legacy bare-array format", raw: JSON.stringify(CACHED) },
      { name: "malformed JSON", raw: "{not json" },
    ])("never uploads a cache in $name, and deletes it", async ({ raw }) => {
      await chrome.storage.local.set({ [PERSONAL_BOOKS_CACHE_KEY]: raw });
      const api = makeApi({ data: null });

      await migratePersonalBooksCache(USER_ID, api);

      expect(api.updatePersonalBooks).not.toHaveBeenCalled();
      expect(api.getPersonalBooks).not.toHaveBeenCalled();
      expect(await cacheStillThere()).toBe(false);
    });
  });

  it("does nothing at all without a cache", async () => {
    await chrome.storage.local.clear();
    const api = makeApi({ data: null });

    await migratePersonalBooksCache(USER_ID, api);

    expect(api.getPersonalBooks).not.toHaveBeenCalled();
    expect(api.updatePersonalBooks).not.toHaveBeenCalled();
  });
});
