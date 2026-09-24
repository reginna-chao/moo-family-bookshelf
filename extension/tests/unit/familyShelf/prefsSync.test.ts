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
 * StrictMode relies on, results that settle while detached, and `getIo()`
 * being read at flush time.
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

const LOADED: LoadResponse = {
  data: { familyShelfPrefs: { hidden: ["o1:b1"], favorites: ["o2:b2"] } },
};
const FLUSH_ERROR = {
  error: { code: "INTERNAL_ERROR", message: "boom" },
} satisfies FlushResponse;

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
      expect(onSyncFailed).toHaveBeenCalledTimes(1);
      expect(onSyncFailed).toHaveBeenCalledWith(true);
    });

    it("publishes the outcome of the flush detach() fired once the instance is re-attached", async () => {
      const api = createApi();
      const flushResult = deferred<FlushResponse>();
      api.updateFamilyPrefs.mockReturnValueOnce(flushResult.promise);
      const { sync, onSyncFailed } = createSync({ userId: "user-1", api });

      sync.attach();
      sync.toggle("favorites", "o1:b1");
      sync.detach();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
      sync.attach();

      flushResult.resolve(FLUSH_ERROR);
      await settle();
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
    // Each row runs twice: `detached: false` is the positive companion proving
    // the callback DOES fire on the same path, so the `detached: true` row
    // cannot pass vacuously.
    const cases = [
      { name: "load result", op: "load", outcome: "resolve" },
      { name: "flush { error } envelope", op: "flush", outcome: "resolve" },
      { name: "flush rejection", op: "flush", outcome: "reject" },
    ] as const;

    describe.each(cases)("$name", ({ op, outcome }) => {
      it.each([
        { detached: true, published: false },
        { detached: false, published: true },
      ])(
        "detached=$detached → published=$published",
        async ({ detached, published }) => {
          const api = createApi();
          const pending = deferred<LoadResponse>();
          const { sync, onRefs, onSyncFailed } = createSync({
            userId: "user-1",
            api,
          });
          sync.attach();

          if (op === "load") {
            api.getPersonalBooks.mockReturnValueOnce(pending.promise);
            sync.load();
          } else {
            api.updateFamilyPrefs.mockReturnValueOnce(pending.promise);
            sync.toggle("hidden", "o1:b1");
            vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
            expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(1);
          }
          onRefs.mockClear();

          if (detached) sync.detach();
          if (outcome === "resolve") {
            pending.resolve(op === "load" ? LOADED : FLUSH_ERROR);
          } else {
            pending.reject(new Error("network down"));
          }
          await settle();

          const callback = op === "load" ? onRefs : onSyncFailed;
          expect(callback.mock.calls.length > 0).toBe(published);
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
  });

  describe("flush reads getIo() at flush time", () => {
    it.each([
      { trigger: "debounce timer" as const },
      { trigger: "detach()" as const },
    ])(
      "sends through the CURRENT userId/api when fired by the $trigger",
      ({ trigger }) => {
        const apiA = createApi();
        const apiB = createApi();
        const { sync, setIo } = createSync({ userId: "user-a", api: apiA });

        sync.attach();
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
        setup: () => {},
        callsAfterDetach: 0,
      },
      {
        name: "sends nothing more when the debounce already fired",
        setup: (sync: FamilyPrefsSync) => {
          sync.toggle("hidden", "o1:b1");
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);
        },
        callsAfterDetach: 1,
      },
      {
        name: "flushes a pending toggle immediately, exactly once",
        setup: (sync: FamilyPrefsSync) => {
          sync.toggle("hidden", "o1:b1");
          vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
        },
        callsAfterDetach: 1,
      },
    ])("$name", ({ setup, callsAfterDetach }) => {
      const api = createApi();
      const { sync } = createSync({ userId: "user-1", api });

      sync.attach();
      setup(sync);
      sync.detach();
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(callsAfterDetach);

      // The cleared timer never fires a second request.
      vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 2);
      expect(api.updateFamilyPrefs).toHaveBeenCalledTimes(callsAfterDetach);
    });
  });
});
