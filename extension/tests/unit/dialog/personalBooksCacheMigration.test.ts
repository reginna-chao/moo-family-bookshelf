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
 *
 * #328: a failed upload (an `{ error }` answer or a thrown request) keeps the
 * cache and never rejects, so the next attempt — onboarding's first book sync
 * (`useAutoSetup.syncBooks`) — can retry it. The cache is removed only after a
 * successful upload or when the server already holds a record.
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

function settle(response: unknown | Error) {
  return response instanceof Error
    ? vi.fn().mockRejectedValue(response)
    : vi.fn().mockResolvedValue(response);
}

function makeApi(
  getResponse: unknown | Error,
  updateResponse: unknown | Error = { data: { ok: true } },
): ApiClient {
  return {
    getPersonalBooks: settle(getResponse),
    updatePersonalBooks: settle(updateResponse),
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

  // #328: see the header.
  describe("a failed upload while the server has no record (#328)", () => {
    const FAILED_UPLOADS = [
      {
        name: "answers with an error",
        update: { error: { code: "INTERNAL_ERROR", message: "x" } },
      },
      { name: "throws", update: new Error("network down") },
    ];

    it.each(FAILED_UPLOADS)(
      "keeps the cache and resolves when the upload $name",
      async ({ update }) => {
        const api = makeApi({ data: null }, update);

        await expect(
          migratePersonalBooksCache(USER_ID, api),
        ).resolves.toBeUndefined();

        expect(api.updatePersonalBooks).toHaveBeenCalledTimes(1);
        expect(await cacheStillThere()).toBe(true);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      },
    );

    it.each(FAILED_UPLOADS)(
      "uploads the kept cache on the next attempt, then removes it (upload $name first)",
      async ({ update }) => {
        await migratePersonalBooksCache(
          USER_ID,
          makeApi({ data: null }, update),
        );
        const retryApi = makeApi({ data: null });

        await migratePersonalBooksCache(USER_ID, retryApi);

        expect(retryApi.updatePersonalBooks).toHaveBeenCalledWith(
          USER_ID,
          expect.objectContaining({ userId: USER_ID, books: CACHED }),
        );
        expect(await cacheStillThere()).toBe(false);
      },
    );
  });

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
