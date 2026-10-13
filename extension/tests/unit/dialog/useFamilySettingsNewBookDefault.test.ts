import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFamilySettingsNewBookDefault } from "@/dialog/useFamilySettingsNewBookDefault";
import { BoolFlag, type ApiClient } from "@/api/client";

/**
 * The 新書預設開放 switch hook (#238). The setting lives in the server record,
 * so the hook reads it once per mount through `getPersonalBooks` and saves each
 * toggle straight away through `updateNewBookDefault` (PUT
 * /api/user/:id/new-book-default): optimistic, rolled back when the save fails.
 *
 * Only an exact `BoolFlag.TRUE` reads as on — `true` / `"1"` / a missing field
 * are off. No record at all (`data: null`, nothing synced yet) is `noRecord`:
 * disabled, with a hint to sync first: the Worker's PUT stores the setting under
 * its own key either way, but its GET reports it only alongside an existing books
 * record, so until the first sync the stored value cannot be read back. A failed
 * read leaves the switch disabled (`loadFailed`) rather than showing a guessed
 * value. A 404 `NOT_FOUND` on save is what a
 * server predating the setting answers: the switch rolls back and turns
 * `unsupported` (disabled, hint message). Any other failure rolls back with a
 * retry message. While a save is in flight, and before the read finishes,
 * toggles are ignored.
 *
 * The user-visible strings are pinned here against the production hook (they
 * are module-private constants), and asserted again where FamilySettings
 * renders them (tests/component/FamilySettings.test.tsx).
 */

const USER_ID = "a".repeat(64);
const LOAD_FAILED = "載入設定失敗，請稍後再試";
const SAVE_FAILED = "儲存失敗，請稍後再試";
const UNSUPPORTED = "伺服器尚未支援這個設定";
const NO_RECORD = "同步一次書單後就能設定";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createClient(
  overrides: {
    getPersonalBooks?: ReturnType<typeof vi.fn>;
    updateNewBookDefault?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const getPersonalBooks =
    overrides.getPersonalBooks ??
    vi.fn().mockResolvedValue({ data: { books: [], newBookDefaultShared: 0 } });
  const updateNewBookDefault =
    overrides.updateNewBookDefault ??
    vi
      .fn()
      .mockImplementation((_id: string, flag: BoolFlag) =>
        Promise.resolve({ data: { ok: true, newBookDefaultShared: flag } }),
      );
  const client = {
    getPersonalBooks,
    updateNewBookDefault,
  } as unknown as ApiClient;
  return { client, getPersonalBooks, updateNewBookDefault };
}

function storedSetting(value: unknown) {
  return vi.fn().mockResolvedValue({
    data: { books: [], newBookDefaultShared: value },
  });
}

/** Flush pending promise callbacks inside act(), so their state updates commit. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountReady(client: ApiClient) {
  const hook = renderHook(() =>
    useFamilySettingsNewBookDefault(client, USER_ID),
  );
  await settle();
  return hook;
}

describe("useFamilySettingsNewBookDefault", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("reading the stored setting", () => {
    it("starts loading and off, with the switch not yet accepting toggles", async () => {
      const { client, updateNewBookDefault } = createClient({
        getPersonalBooks: storedSetting(BoolFlag.TRUE),
      });
      const { result } = renderHook(() =>
        useFamilySettingsNewBookDefault(client, USER_ID),
      );

      expect(result.current.status).toBe("loading");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
      expect(result.current.message).toBe("");

      act(() => result.current.handleToggleNewBookDefault());
      expect(updateNewBookDefault).not.toHaveBeenCalled();
      await settle();
    });

    it("reads an exact BoolFlag.TRUE as on, with one request for this user", async () => {
      const { client, getPersonalBooks } = createClient({
        getPersonalBooks: storedSetting(BoolFlag.TRUE),
      });

      const { result } = await mountReady(client);

      expect(result.current.status).toBe("ready");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(result.current.message).toBe("");
      expect(getPersonalBooks).toHaveBeenCalledTimes(1);
      expect(getPersonalBooks).toHaveBeenCalledWith(USER_ID);
    });

    it.each([
      { name: "0", response: { data: { books: [], newBookDefaultShared: 0 } } },
      { name: "a missing field", response: { data: { books: [] } } },
      {
        name: "true",
        response: { data: { books: [], newBookDefaultShared: true } },
      },
      {
        name: '"1"',
        response: { data: { books: [], newBookDefaultShared: "1" } },
      },
    ])("reads $name as off and ready", async ({ response }) => {
      const { client } = createClient({
        getPersonalBooks: vi.fn().mockResolvedValue(response),
      });

      const { result } = await mountReady(client);

      expect(result.current.status).toBe("ready");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
      expect(result.current.message).toBe("");
    });

    it("turns noRecord with the sync-first message when the user has no record yet", async () => {
      const { client, updateNewBookDefault } = createClient({
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      });

      const { result } = await mountReady(client);

      expect(result.current.status).toBe("noRecord");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
      expect(result.current.message).toBe(NO_RECORD);
      act(() => result.current.handleToggleNewBookDefault());
      expect(updateNewBookDefault).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "answers an error envelope",
        getPersonalBooks: () =>
          vi.fn().mockResolvedValue({
            error: { code: "INTERNAL_ERROR", message: "boom" },
          }),
      },
      {
        name: "rejects",
        getPersonalBooks: () => vi.fn().mockRejectedValue(new Error("offline")),
      },
    ])(
      "turns loadFailed with the load message when the read $name",
      async ({ getPersonalBooks }) => {
        const { client, updateNewBookDefault } = createClient({
          getPersonalBooks: getPersonalBooks(),
        });

        const { result } = await mountReady(client);

        expect(result.current.status).toBe("loadFailed");
        expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
        expect(result.current.message).toBe(LOAD_FAILED);
        act(() => result.current.handleToggleNewBookDefault());
        expect(updateNewBookDefault).not.toHaveBeenCalled();
      },
    );

    it("does not re-read on a re-render with the same client and user", async () => {
      const { client, getPersonalBooks } = createClient();
      const { rerender } = await mountReady(client);

      rerender();
      await settle();

      expect(getPersonalBooks).toHaveBeenCalledTimes(1);
    });
  });

  describe("toggling", () => {
    it("switches optimistically and saves TRUE, then FALSE on the next toggle", async () => {
      const save = deferred<unknown>();
      const { client, updateNewBookDefault } = createClient({
        updateNewBookDefault: vi.fn().mockReturnValueOnce(save.promise),
      });
      const { result } = await mountReady(client);

      act(() => result.current.handleToggleNewBookDefault());

      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(result.current.saving).toBe(true);
      expect(updateNewBookDefault).toHaveBeenLastCalledWith(
        USER_ID,
        BoolFlag.TRUE,
      );

      await act(async () => {
        save.resolve({ data: { ok: true, newBookDefaultShared: 1 } });
      });
      expect(result.current.saving).toBe(false);
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(result.current.message).toBe("");

      updateNewBookDefault.mockResolvedValueOnce({
        data: { ok: true, newBookDefaultShared: 0 },
      });
      act(() => result.current.handleToggleNewBookDefault());
      await settle();

      expect(updateNewBookDefault).toHaveBeenCalledTimes(2);
      expect(updateNewBookDefault).toHaveBeenLastCalledWith(
        USER_ID,
        BoolFlag.FALSE,
      );
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
    });

    it("ignores toggles while a save is in flight", async () => {
      const save = deferred<unknown>();
      const { client, updateNewBookDefault } = createClient({
        updateNewBookDefault: vi.fn().mockReturnValueOnce(save.promise),
      });
      const { result } = await mountReady(client);

      act(() => result.current.handleToggleNewBookDefault());
      act(() => result.current.handleToggleNewBookDefault());
      act(() => result.current.handleToggleNewBookDefault());

      expect(updateNewBookDefault).toHaveBeenCalledTimes(1);
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);

      await act(async () => {
        save.resolve({ data: { ok: true, newBookDefaultShared: 1 } });
      });
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
    });

    it.each([
      {
        name: "answers a non-404 error",
        update: () =>
          vi.fn().mockResolvedValue({
            error: { code: "INTERNAL_ERROR", message: "boom" },
          }),
      },
      {
        name: "is rate limited",
        update: () =>
          vi.fn().mockResolvedValue({
            error: { code: "RATE_LIMITED", message: "slow down" },
          }),
      },
      {
        name: "throws",
        update: () => vi.fn().mockRejectedValue(new Error("offline")),
      },
    ])(
      "rolls back and shows the retry message when the save $name",
      async ({ update }) => {
        const { client } = createClient({ updateNewBookDefault: update() });
        const { result } = await mountReady(client);

        act(() => result.current.handleToggleNewBookDefault());
        expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
        await settle();

        expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
        expect(result.current.saving).toBe(false);
        expect(result.current.status).toBe("ready");
        expect(result.current.message).toBe(SAVE_FAILED);
      },
    );

    it("clears the retry message when the next toggle starts", async () => {
      const update = vi
        .fn()
        .mockResolvedValueOnce({
          error: { code: "INTERNAL_ERROR", message: "" },
        })
        .mockResolvedValueOnce({ data: { ok: true, newBookDefaultShared: 1 } });
      const { client } = createClient({ updateNewBookDefault: update });
      const { result } = await mountReady(client);

      act(() => result.current.handleToggleNewBookDefault());
      await settle();
      expect(result.current.message).toBe(SAVE_FAILED);

      act(() => result.current.handleToggleNewBookDefault());
      expect(result.current.message).toBe("");
      await settle();
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(result.current.message).toBe("");
    });

    it("rolls back and turns unsupported on a 404 NOT_FOUND, then ignores further toggles", async () => {
      const update = vi.fn().mockResolvedValue({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
      const { client } = createClient({
        getPersonalBooks: storedSetting(BoolFlag.TRUE),
        updateNewBookDefault: update,
      });
      const { result } = await mountReady(client);

      act(() => result.current.handleToggleNewBookDefault());
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
      await settle();

      expect(update).toHaveBeenCalledWith(USER_ID, BoolFlag.FALSE);
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.TRUE);
      expect(result.current.status).toBe("unsupported");
      expect(result.current.message).toBe(UNSUPPORTED);
      expect(result.current.message).not.toBe(SAVE_FAILED);

      act(() => result.current.handleToggleNewBookDefault());
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe("stale responses", () => {
    it("ignores a previous user's read that resolves after the next user's read", async () => {
      const staleRead = deferred<unknown>();
      const nextUserId = "b".repeat(64);
      const getPersonalBooks = vi
        .fn()
        .mockReturnValueOnce(staleRead.promise)
        .mockResolvedValueOnce({
          data: { books: [], newBookDefaultShared: 0 },
        });
      const { client } = createClient({ getPersonalBooks });
      const { result, rerender } = renderHook(
        ({ userId }) => useFamilySettingsNewBookDefault(client, userId),
        { initialProps: { userId: USER_ID } },
      );

      rerender({ userId: nextUserId });
      await settle();
      expect(getPersonalBooks).toHaveBeenNthCalledWith(2, nextUserId);
      expect(result.current.status).toBe("ready");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);

      await act(async () => {
        staleRead.resolve({ data: { books: [], newBookDefaultShared: 1 } });
      });

      expect(result.current.status).toBe("ready");
      expect(result.current.newBookDefaultShared).toBe(BoolFlag.FALSE);
    });

    it("does not throw when a save resolves after unmount", async () => {
      const save = deferred<unknown>();
      const { client } = createClient({
        updateNewBookDefault: vi.fn().mockReturnValueOnce(save.promise),
      });
      const { result, unmount } = await mountReady(client);

      act(() => result.current.handleToggleNewBookDefault());
      unmount();
      await act(async () => {
        save.resolve({ error: { code: "NOT_FOUND", message: "" } });
      });

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
