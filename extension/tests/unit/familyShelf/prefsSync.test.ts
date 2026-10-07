import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import {
  FamilyPrefsSync,
  FLUSH_DEBOUNCE_MS,
  type FamilyPrefKind,
  type FamilyPrefsApi,
  type FamilyPrefsIo,
} from "moo-family-bookshelf-shared/familyShelf/prefsSync";
import type {
  ApiResponse,
  PersonalBooks,
} from "moo-family-bookshelf-shared/api/types";

/**
 * Controller-level lifecycle of the shared `FamilyPrefsSync`
 * (`shared/src/familyShelf/prefsSync.ts`). `shared/` has no test runner of its
 * own, so its behaviour is covered from here.
 *
 * The two React adapters are already pinned by
 * `tests/unit/dialog/useFamilyShelfPrefs.test.ts` and
 * `pwa/tests/unit/hooks/useFamilyShelfPrefs.test.ts` (load shape, optimistic
 * toggle, debounce payload, syncFailed signal, unmount flush). This file pins
 * what a single mount/unmount cannot reach: the detach → attach re-entrancy
 * StrictMode relies on, results that settle while detached, `getIo()` being
 * read at flush time, and the issue #219 invariant — no full-replace PUT
 * before a load has succeeded.
 */

type LoadResponse = ApiResponse<Pick<PersonalBooks, "familyShelfPrefs">>;
type FlushResponse = ApiResponse<unknown>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake timers leave microtasks alone — drain them so awaited mocks settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

interface MockApi extends FamilyPrefsApi {
  getPersonalBooks: Mock<FamilyPrefsApi["getPersonalBooks"]>;
  updateFamilyPrefs: Mock<FamilyPrefsApi["updateFamilyPrefs"]>;
}

function createApi(): MockApi {
  return {
    getPersonalBooks: vi
      .fn<FamilyPrefsApi["getPersonalBooks"]>()
      .mockResolvedValue({
        data: { familyShelfPrefs: { hidden: [], favorites: [] } },
      }),
    updateFamilyPrefs: vi
      .fn<FamilyPrefsApi["updateFamilyPrefs"]>()
      .mockResolvedValue({ data: { ok: true } }),
  };
}

function createSync(initialIo: FamilyPrefsIo) {
  let io = initialIo;
  const onRefs = vi.fn<(kind: FamilyPrefKind, refs: Set<string>) => void>();
  const onSyncFailed = vi.fn<(failed: boolean) => void>();
  const sync = new FamilyPrefsSync({
    getIo: () => io,
    onRefs,
    onSyncFailed,
  });
  return {
    sync,
    onRefs,
    onSyncFailed,
    setIo: (next: FamilyPrefsIo) => {
      io = next;
    },
  };
}

/** attach() + one successful (empty) load, settled — the precondition for any PUT. */
async function attachAndLoad(sync: FamilyPrefsSync): Promise<void> {
  sync.attach();
  sync.load();
  await settle();
}

/** The body of the `index`-th PUT, with each list sorted (order-insensitive). */
function sortedPutBody(api: MockApi, index = 0) {
  const [userId, prefs] = api.updateFamilyPrefs.mock.calls[index];
  return {
    userId,
    hidden: [...prefs.hidden].sort(),
    favorites: [...prefs.favorites].sort(),
  };
}

/** The most recent set published for `kind`. */
function lastPublished(
  onRefs: Mock<(kind: FamilyPrefKind, refs: Set<string>) => void>,
  kind: FamilyPrefKind,
): Set<string> {
  const calls = onRefs.mock.calls.filter(([k]) => k === kind);
  return calls[calls.length - 1][1];
}

const LOADED: LoadResponse = {
  data: { familyShelfPrefs: { hidden: ["o1:b1"], favorites: ["o2:b2"] } },
};
/** The server-side lists the #219 scenario must preserve. */
const SERVER_PREFS: LoadResponse = {
  data: { familyShelfPrefs: { hidden: ["o:a"], favorites: ["o:f"] } },
};
const LOAD_ERROR = {
  error: { code: "NETWORK_ERROR", message: "x" },
} satisfies LoadResponse;
const FLUSH_ERROR = {
  error: { code: "INTERNAL_ERROR", message: "boom" },
} satisfies FlushResponse;

/** The two ways a load fails: an `{ error }` envelope, or a rejection. */
const LOAD_FAILURES = [
  {
    failure: "{ error } envelope",
    fail: (d: Deferred<LoadResponse>) => d.resolve(LOAD_ERROR),
  },
  {
    failure: "rejection",
    fail: (d: Deferred<LoadResponse>) => d.reject(new Error("offline")),
  },
] as const;

describe("FamilyPrefsSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("detach → attach re-entrancy (StrictMode dev remount)", () => {
    it("publishes a load that settles after re-attach, and toggle + debounce + flush keep working on the same instance", async () => {
      const api = createApi();
      const load = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(load.promise);
      const flushResult = deferred<FlushResponse>();
      api.updateFamilyPrefs.mockReturnValueOnce(flushResult.promise);
      const { sync, onRefs, onSyncFailed } = createSync({
        userId: "user-1",
        api,
      });

      sync.attach();
      sync.load();
      sync.detach();
      sync.attach();

      load.resolve(LOADED);
      await settle();
      expect(onRefs).toHaveBeenCalledWith("hidden", new Set(["o1:b1"]));
      expect(onRefs).toHaveBeenCalledWith("favorites", new Set(["o2:b2"]));

      sync.toggle("hidden", "o3:b3");
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      expect(api.updateFamilyPrefs).toHaveBeenCalledWith("user-1", {
        hidden: ["o1:b1", "o3:b3"],
        favorites: ["o2:b2"],
      });

      flushResult.resolve(FLUSH_ERROR);
      await settle();
      // The successful load (no pre-load toggles) publishes "not failed"
      // first; the failed flush then publishes "failed".
      expect(onSyncFailed).toHaveBeenCalledTimes(2);
      expect(onSyncFailed).toHaveBeenNthCalledWith(1, false);
      expect(onSyncFailed).toHaveBeenNthCalledWith(2, true);
    });

    it("publishes the outcome of the flush detach() fired once the instance is re-attached", async () => {
      const api = createApi();
      const flushResult = deferred<FlushResponse>();
      api.updateFamilyPrefs.mockReturnValueOnce(flushResult.promise);
      const { sync, onSyncFailed } = createSync({ userId: "user-1", api });

      await attachAndLoad(sync);
      onSyncFailed.mockClear();
      sync.toggle("favorites", "o1:b1");
      sync.detach();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      sync.attach();

      flushResult.resolve(FLUSH_ERROR);
      await settle();
      expect(onSyncFailed).toHaveBeenCalledTimes(1);
      expect(onSyncFailed).toHaveBeenCalledWith(true);

      // A later toggle on the re-attached instance still debounces and flushes.
      sync.toggle("favorites", "o4:b4");
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(2);
      expect(api.updateFamilyPrefs).toHaveBeenLastCalledWith("user-1", {
        hidden: [],
        favorites: ["o1:b1", "o4:b4"],
      });
      await settle();
      expect(onSyncFailed).toHaveBeenLastCalledWith(false);
    });
  });

  describe("results that settle while detached", () => {
    // Each row runs twice: `detached: false` proves the callback DOES fire on that
    // path, so the `detached: true` row cannot pass vacuously.
    const cases = [
      {
        name: "load result",
        op: "load",
        callback: "onRefs",
        settleWith: (d: Deferred<LoadResponse>) => d.resolve(LOADED),
      },
      {
        name: "load { error } envelope",
        op: "load",
        callback: "onSyncFailed",
        settleWith: (d: Deferred<LoadResponse>) => d.resolve(LOAD_ERROR),
      },
      {
        name: "load rejection",
        op: "load",
        callback: "onSyncFailed",
        settleWith: (d: Deferred<LoadResponse>) =>
          d.reject(new Error("network down")),
      },
      {
        name: "flush { error } envelope",
        op: "flush",
        callback: "onSyncFailed",
        settleWith: (d: Deferred<LoadResponse>) => d.resolve(FLUSH_ERROR),
      },
      {
        name: "flush rejection",
        op: "flush",
        callback: "onSyncFailed",
        settleWith: (d: Deferred<LoadResponse>) =>
          d.reject(new Error("network down")),
      },
    ] as const;

    describe.each(cases)("$name", ({ op, callback, settleWith }) => {
      it.each([
        { detached: true, published: false },
        { detached: false, published: true },
      ])(
        "detached=$detached → published=$published",
        async ({ detached, published }) => {
          const api = createApi();
          const pending = deferred<LoadResponse>();
          const mocks = createSync({ userId: "user-1", api });
          const { sync, onRefs, onSyncFailed } = mocks;

          if (op === "load") {
            sync.attach();
            api.getPersonalBooks.mockReturnValueOnce(pending.promise);
            sync.load();
          } else {
            // A flush is only ever sent after a successful load.
            await attachAndLoad(sync);
            api.updateFamilyPrefs.mockReturnValueOnce(pending.promise);
            sync.toggle("hidden", "o1:b1");
            vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
            expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
          }
          onRefs.mockClear();
          onSyncFailed.mockClear();

          if (detached) sync.detach();
          settleWith(pending);
          await settle();

          expect(mocks[callback].mock.calls.length > 0).toBe(published);
          // A flush already in flight is not repeated by detach().
          if (op === "flush") {
            expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
          }
        },
      );
    });

    it("does not mark the load done when it resolved while detached — the next load() re-fetches", async () => {
      const api = createApi();
      const first = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(first.promise);
      const { sync, onRefs } = createSync({ userId: "user-1", api });

      sync.attach();
      sync.load();
      sync.detach();
      first.resolve({
        data: { familyShelfPrefs: { hidden: ["stale:x"], favorites: [] } },
      });
      await settle();
      expect(onRefs).not.toHaveBeenCalled();

      sync.attach();
      api.getPersonalBooks.mockResolvedValueOnce(LOADED);
      sync.load();
      await settle();

      expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
      expect(onRefs).toHaveBeenCalledWith("hidden", new Set(["o1:b1"]));
      expect(onRefs).not.toHaveBeenCalledWith("hidden", new Set(["stale:x"]));
    });
  });

  describe("load()", () => {
    it.each([
      {
        name: "retries after a rejected load (didLoad stays false)",
        firstRejects: true,
        expectedCalls: 2,
      },
      {
        name: "is a no-op after a successful load",
        firstRejects: false,
        expectedCalls: 1,
      },
    ])("$name", async ({ firstRejects, expectedCalls }) => {
      const api = createApi();
      if (firstRejects) {
        api.getPersonalBooks.mockRejectedValueOnce(new Error("boom"));
      } else {
        api.getPersonalBooks.mockResolvedValueOnce(LOADED);
      }
      const { sync, onRefs } = createSync({ userId: "user-1", api });

      sync.attach();
      sync.load();
      await settle();
      expect(onRefs.mock.calls.length > 0).toBe(!firstRejects);

      sync.load();
      await settle();
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(expectedCalls);
    });

    it.each(LOAD_FAILURES)(
      "keeps a single GET in flight, then fetches again once it failed ($failure)",
      async ({ fail }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        api.getPersonalBooks.mockReturnValueOnce(first.promise);
        const { sync } = createSync({ userId: "user-1", api });

        sync.attach();
        sync.load();
        sync.load();
        sync.load();
        expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);

        fail(first);
        await settle();
        sync.load();
        await settle();
        expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
      },
    );

    it.each(LOAD_FAILURES)(
      "publishes onSyncFailed(true) and leaves the published sets untouched on a failed load ($failure)",
      async ({ fail }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        api.getPersonalBooks.mockReturnValueOnce(first.promise);
        const { sync, onRefs, onSyncFailed } = createSync({
          userId: "user-1",
          api,
        });

        sync.attach();
        sync.load();
        fail(first);
        await settle();

        expect(onSyncFailed).toHaveBeenCalledTimes(1);
        expect(onSyncFailed).toHaveBeenCalledWith(true);
        expect(onRefs).not.toHaveBeenCalled();
        expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
      },
    );

    it.each([
      // `{ data: null }` is what the Worker answers for a user with no record
      // yet; the wire type spells `data` as optional, hence the cast.
      { name: "{ data: null }", response: { data: null } as unknown },
      { name: "{ data: {} }", response: { data: {} } },
      { name: "{} (no data, no error)", response: {} },
    ])(
      "treats $name as a successful EMPTY load, so a later toggle is saved",
      async ({ response }) => {
        const api = createApi();
        api.getPersonalBooks.mockResolvedValueOnce(response as LoadResponse);
        const { sync, onRefs, onSyncFailed } = createSync({
          userId: "user-1",
          api,
        });

        await attachAndLoad(sync);
        expect(onSyncFailed).toHaveBeenCalledTimes(1);
        expect(onSyncFailed).toHaveBeenCalledWith(false);
        expect(onRefs).toHaveBeenCalledWith("hidden", new Set());
        expect(onRefs).toHaveBeenCalledWith("favorites", new Set());

        sync.toggle("hidden", "o:t");
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

        expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);
        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(api.updateFamilyPrefs).toHaveBeenCalledWith("user-1", {
          hidden: ["o:t"],
          favorites: [],
        });
      },
    );

    it("clears a sync-failed notice when a retried load succeeds with no pre-load toggles", async () => {
      const api = createApi();
      api.getPersonalBooks.mockResolvedValueOnce(LOAD_ERROR);
      const { sync, onSyncFailed } = createSync({ userId: "user-1", api });

      await attachAndLoad(sync);
      expect(onSyncFailed).toHaveBeenLastCalledWith(true);

      sync.load();
      await settle();

      expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
      expect(onSyncFailed).toHaveBeenCalledTimes(2);
      expect(onSyncFailed).toHaveBeenNthCalledWith(1, true);
      expect(onSyncFailed).toHaveBeenNthCalledWith(2, false);
      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
    });
  });

  describe("no full-replace PUT before a successful load (issue #219)", () => {
    it.each(LOAD_FAILURES)(
      "after a failed load ($failure), the debounce retries the load instead of saving, then saves server lists + toggle exactly once",
      async ({ fail }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        const retry = deferred<LoadResponse>();
        api.getPersonalBooks
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(retry.promise);
        const { sync, onRefs, onSyncFailed } = createSync({
          userId: "user-1",
          api,
        });

        sync.attach();
        sync.load();
        fail(first);
        await settle();
        expect(onSyncFailed).toHaveBeenCalledWith(true);
        expect(onRefs).not.toHaveBeenCalled();

        // Optimistic: the toggle shows immediately even though nothing loaded.
        sync.toggle("hidden", "o:t");
        expect(onRefs).toHaveBeenLastCalledWith("hidden", new Set(["o:t"]));

        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        // The PUT this would have been is what wiped the saved lists.
        expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
        expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);

        retry.resolve(SERVER_PREFS);
        await settle();

        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(sortedPutBody(api)).toEqual({
          userId: "user-1",
          hidden: ["o:a", "o:t"],
          favorites: ["o:f"],
        });
        expect(lastPublished(onRefs, "hidden")).toEqual(
          new Set(["o:a", "o:t"]),
        );
        expect(lastPublished(onRefs, "favorites")).toEqual(new Set(["o:f"]));
        expect(onSyncFailed).toHaveBeenLastCalledWith(false);

        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 3);
        await settle();
        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
      },
    );

    it.each(LOAD_FAILURES)(
      "keeps a toggle made while the load was in flight across that load's failure ($failure)",
      async ({ fail }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        api.getPersonalBooks
          .mockReturnValueOnce(first.promise)
          .mockResolvedValueOnce(SERVER_PREFS);
        const { sync, onRefs } = createSync({ userId: "user-1", api });

        sync.attach();
        sync.load();
        sync.toggle("favorites", "o:t");
        fail(first);
        await settle();
        // The failure does not overwrite the optimistic set.
        expect(onRefs).toHaveBeenCalledTimes(1);
        expect(api.updateFamilyPrefs).not.toHaveBeenCalled();

        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
        await settle();

        expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);
        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(sortedPutBody(api)).toEqual({
          userId: "user-1",
          hidden: ["o:a"],
          favorites: ["o:f", "o:t"],
        });
      },
    );

    it("does not save or re-fetch when the debounce fires while the first load is still in flight; the load then saves the merged lists once", async () => {
      const api = createApi();
      const first = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(first.promise);
      const { sync } = createSync({ userId: "user-1", api });

      sync.attach();
      sync.load();
      sync.toggle("hidden", "o:t");
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 100);

      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);

      first.resolve(SERVER_PREFS);
      await settle();

      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      expect(sortedPutBody(api)).toEqual({
        userId: "user-1",
        hidden: ["o:a", "o:t"],
        favorites: ["o:f"],
      });

      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 3);
      await settle();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);
    });

    it("saves immediately when the load succeeds inside the debounce window, and the cancelled timer sends nothing more", async () => {
      const api = createApi();
      const first = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(first.promise);
      const { sync } = createSync({ userId: "user-1", api });

      sync.attach();
      sync.load();
      sync.toggle("hidden", "o:t");
      sync.toggle("favorites", "o:u");
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 100);

      first.resolve(SERVER_PREFS);
      await settle();

      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      expect(sortedPutBody(api)).toEqual({
        userId: "user-1",
        hidden: ["o:a", "o:t"],
        favorites: ["o:f", "o:u"],
      });

      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 3);
      await settle();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
    });

    it.each([
      { kind: "hidden" as const, ref: "o:a" },
      { kind: "favorites" as const, ref: "o:f" },
    ])(
      "keeps a $kind ref the server already has marked when it was toggled once before the load",
      async ({ kind, ref }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        api.getPersonalBooks.mockReturnValueOnce(first.promise);
        const { sync, onRefs } = createSync({ userId: "user-1", api });

        sync.attach();
        sync.load();
        // Before the load every book shows unmarked, so this click can only
        // mean "mark it" — it must never remove the mark the server holds.
        sync.toggle(kind, ref);
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        first.resolve(SERVER_PREFS);
        await settle();

        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(sortedPutBody(api)).toEqual({
          userId: "user-1",
          hidden: ["o:a"],
          favorites: ["o:f"],
        });
        expect(lastPublished(onRefs, "hidden")).toEqual(new Set(["o:a"]));
        expect(lastPublished(onRefs, "favorites")).toEqual(new Set(["o:f"]));
      },
    );

    it.each(LOAD_FAILURES)(
      "does not delete a server favorite re-marked after a failed load ($failure) — the retry's single PUT keeps both server lists",
      async ({ fail }) => {
        const api = createApi();
        const first = deferred<LoadResponse>();
        const retry = deferred<LoadResponse>();
        api.getPersonalBooks
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(retry.promise);
        const { sync, onRefs } = createSync({ userId: "user-1", api });

        sync.attach();
        sync.load();
        fail(first);
        await settle();

        // The UI shows "o:X" unmarked (nothing loaded), so the user marks it.
        sync.toggle("favorites", "o:X");
        vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
        expect(api.getPersonalBooks).toHaveBeenCalledTimes(2);

        retry.resolve({
          data: { familyShelfPrefs: { hidden: ["o:H"], favorites: ["o:X"] } },
        });
        await settle();

        expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(sortedPutBody(api)).toEqual({
          userId: "user-1",
          hidden: ["o:H"],
          favorites: ["o:X"],
        });
        expect(lastPublished(onRefs, "favorites")).toEqual(new Set(["o:X"]));
        expect(lastPublished(onRefs, "hidden")).toEqual(new Set(["o:H"]));
      },
    );

    it("cancels a ref toggled twice before the load: no PUT, onSyncFailed(false), server lists published", async () => {
      const api = createApi();
      const first = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(first.promise);
      const { sync, onRefs, onSyncFailed } = createSync({
        userId: "user-1",
        api,
      });

      sync.attach();
      sync.load();
      sync.toggle("hidden", "o:x");
      sync.toggle("hidden", "o:x");
      // The debounce falls due while the load is in flight: joins it, no PUT.
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
      first.resolve(SERVER_PREFS);
      await settle();

      expect(lastPublished(onRefs, "hidden")).toEqual(new Set(["o:a"]));
      expect(lastPublished(onRefs, "favorites")).toEqual(new Set(["o:f"]));
      expect(onSyncFailed).toHaveBeenCalledTimes(1);
      expect(onSyncFailed).toHaveBeenCalledWith(false);

      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 3);
      await settle();
      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);
    });

    it("cancels the pre-load debounce timer when a load with no net toggles succeeds inside the window: no later PUT", async () => {
      const api = createApi();
      const first = deferred<LoadResponse>();
      api.getPersonalBooks.mockReturnValueOnce(first.promise);
      const { sync, onRefs, onSyncFailed } = createSync({
        userId: "user-1",
        api,
      });

      sync.attach();
      sync.load();
      sync.toggle("hidden", "o:x");
      sync.toggle("hidden", "o:x");
      // Resolve while the debounce timer is still pending — no time advanced.
      first.resolve(SERVER_PREFS);
      await settle();

      expect(lastPublished(onRefs, "hidden")).toEqual(new Set(["o:a"]));
      expect(lastPublished(onRefs, "favorites")).toEqual(new Set(["o:f"]));
      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();

      // A surviving timer would fire here and PUT the (unchanged) lists.
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 3);
      await settle();
      expect(api.updateFamilyPrefs).not.toHaveBeenCalled();
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(1);
      expect(onSyncFailed).toHaveBeenCalledTimes(1);
      expect(onSyncFailed).toHaveBeenCalledWith(false);
    });
  });

  describe("flush reads getIo() at flush time", () => {
    it.each([
      { trigger: "debounce timer" as const },
      { trigger: "detach()" as const },
    ])(
      "sends through the CURRENT userId/api when fired by the $trigger",
      async ({ trigger }) => {
        const apiA = createApi();
        const apiB = createApi();
        const { sync, setIo } = createSync({ userId: "user-a", api: apiA });

        await attachAndLoad(sync);
        expect(apiA.getPersonalBooks).toHaveBeenCalledTimes(1);
        sync.toggle("favorites", "o1:b1");
        setIo({ userId: "user-b", api: apiB });

        if (trigger === "detach()") {
          sync.detach();
        } else {
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        }

        expect(apiA.updateFamilyPrefs).not.toHaveBeenCalled();
        expect(apiB.updateFamilyPrefs).toHaveBeenCalledTimes(1);
        expect(apiB.updateFamilyPrefs).toHaveBeenCalledWith("user-b", {
          hidden: [],
          favorites: ["o1:b1"],
        });
      },
    );
  });

  describe("detach()", () => {
    it.each([
      {
        name: "sends nothing when no toggle ever happened",
        loaded: true,
        setup: () => {},
        callsAfterDetach: 0,
      },
      {
        name: "sends nothing more when the debounce already fired",
        loaded: true,
        setup: (sync: FamilyPrefsSync) => {
          sync.toggle("hidden", "o1:b1");
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        },
        callsAfterDetach: 1,
      },
      {
        name: "flushes a pending toggle immediately, exactly once",
        loaded: true,
        setup: (sync: FamilyPrefsSync) => {
          sync.toggle("hidden", "o1:b1");
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
        },
        callsAfterDetach: 1,
      },
      {
        name: "sends nothing for a pending toggle when no load has succeeded",
        loaded: false,
        setup: (sync: FamilyPrefsSync) => {
          sync.toggle("hidden", "o1:b1");
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
        },
        callsAfterDetach: 0,
      },
    ])("$name", async ({ loaded, setup, callsAfterDetach }) => {
      const api = createApi();
      const { sync } = createSync({ userId: "user-1", api });

      if (loaded) {
        await attachAndLoad(sync);
      } else {
        sync.attach();
      }
      const getsBeforeDetach = api.getPersonalBooks.mock.calls.length;
      setup(sync);
      sync.detach();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(callsAfterDetach);

      // The cleared timer never fires later — not even once re-attached,
      // where a surviving timer would PUT (loaded) or retry the load (not).
      sync.attach();
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 2);
      await settle();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(callsAfterDetach);
      expect(api.getPersonalBooks).toHaveBeenCalledTimes(getsBeforeDetach);
    });
  });
});
