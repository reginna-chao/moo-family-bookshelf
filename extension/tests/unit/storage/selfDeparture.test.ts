import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApiResponse } from "@/api/types";
import { SELF_DEPARTURE_UNTIL_KEY } from "@/constants";
import {
  beginSelfDeparture,
  isSelfDepartureActive,
  runGuardedDeparture,
  SELF_DEPARTURE_TTL_MS,
} from "@/storage/selfDeparture";

/**
 * The "own leave / delete-account request in flight" mark (#263), kept in
 * `browser.storage.local` so every extension context sees it. While it is
 * active `doRefreshToken` skips the silent recovery join, so a 401 raised
 * mid-departure cannot re-add the user to the family they are leaving. Storage
 * failures are swallowed in the direction that keeps the user unblocked: a
 * refused write costs the guard, never the leave; an unreadable store reads as
 * "not departing". Twin of `pwa/tests/unit/selfDeparture.test.ts`.
 *
 * Runs against the store-backed `browser.storage.local` mock from
 * `tests/setup.ts`, so a write is what the next read sees.
 */

/** Pinned clock so deadlines can be asserted exactly. */
const NOW = 1_700_000_000_000;

type Res = ApiResponse<{ ok: boolean }>;
const OK: Res = { data: { ok: true } };
const UNAUTHORIZED: Res = {
  error: { code: "UNAUTHORIZED", message: "token revoked" },
};

/** The raw value the store holds for the mark, or undefined. */
async function storedMark(): Promise<unknown> {
  const stored = await chrome.storage.local.get(SELF_DEPARTURE_UNTIL_KEY);
  return stored[SELF_DEPARTURE_UNTIL_KEY];
}

describe("selfDeparture (extension)", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // The store behind the setup mock is module-scoped: clear it while the
    // store-backed implementations are still installed.
    await chrome.storage.local.clear();
    vi.restoreAllMocks();
  });

  describe("beginSelfDeparture / isSelfDepartureActive", () => {
    it("writes a deadline one TTL ahead and reads as active until cleanup", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      expect(SELF_DEPARTURE_TTL_MS).toBe(60_000);

      const end = await beginSelfDeparture();

      expect(await storedMark()).toBe(NOW + SELF_DEPARTURE_TTL_MS);
      expect(await isSelfDepartureActive()).toBe(true);

      await end();

      expect(await storedMark()).toBeUndefined();
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("is inactive when no mark was ever written", async () => {
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("expires on its own after the TTL when the cleanup never runs", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      await beginSelfDeparture(); // cleanup deliberately dropped: context died

      vi.advanceTimersByTime(SELF_DEPARTURE_TTL_MS - 1);
      expect(await isSelfDepartureActive()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("ignores a deadline left further ahead than the TTL by a clock moved back", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      await beginSelfDeparture();

      vi.setSystemTime(NOW - SELF_DEPARTURE_TTL_MS);

      expect(await isSelfDepartureActive()).toBe(false);
    });

    it.each<[string, unknown]>([
      ["a numeric string", String(NOW + 30_000)],
      ["an object", { until: NOW + 30_000 }],
      ["an expired deadline", NOW - 1],
      ["a deadline of exactly now", NOW],
    ])("reads %s as inactive", async (_label, stored) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await chrome.storage.local.set({ [SELF_DEPARTURE_UNTIL_KEY]: stored });

      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("reads as inactive instead of rejecting when the storage read fails", async () => {
      await chrome.storage.local.set({
        [SELF_DEPARTURE_UNTIL_KEY]: Date.now() + 30_000,
      });
      vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
        new Error("Extension context invalidated"),
      );

      await expect(isSelfDepartureActive()).resolves.toBe(false);
    });

    it("still resolves a working cleanup when the storage write fails", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
        new Error("quota"),
      );

      const end = await beginSelfDeparture();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(await isSelfDepartureActive()).toBe(false);
      await expect(end()).resolves.toBeUndefined();
    });

    it("swallows a storage failure inside the cleanup", async () => {
      const end = await beginSelfDeparture();
      vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(
        new Error("Extension context invalidated"),
      );

      await expect(end()).resolves.toBeUndefined();
    });

    it("leaves a later departure's mark in place when an earlier one cleans up", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const endFirst = await beginSelfDeparture();
      // Another tab's dialog starts its own departure a moment later.
      now.mockReturnValue(NOW + 5);
      const endSecond = await beginSelfDeparture();

      await endFirst();

      expect(await storedMark()).toBe(NOW + 5 + SELF_DEPARTURE_TTL_MS);
      expect(await isSelfDepartureActive()).toBe(true);

      await endSecond();

      expect(await storedMark()).toBeUndefined();
    });

    it("finds nothing to remove after the storage was cleared (account deletion)", async () => {
      const end = await beginSelfDeparture();
      await chrome.storage.local.clear();
      vi.mocked(chrome.storage.local.remove).mockClear();

      await expect(end()).resolves.toBeUndefined();

      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
      expect(await storedMark()).toBeUndefined();
    });
  });

  describe("runGuardedDeparture", () => {
    it("sends once with the mark active, settles under the mark, then clears it", async () => {
      const activeAt: Record<string, boolean> = {};
      const send = vi.fn(async () => {
        activeAt.send = await isSelfDepartureActive();
        return OK;
      });
      const settle = vi.fn(async () => {
        activeAt.settle = await isSelfDepartureActive();
      });

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
      expect(activeAt).toEqual({ send: true, settle: true });
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("waits for an async settle before clearing the mark", async () => {
      let releaseSettle!: () => void;
      const settle = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSettle = resolve;
          }),
      );

      const running = runGuardedDeparture(async () => OK, settle);
      await vi.waitFor(() => expect(settle).toHaveBeenCalled());

      expect(await isSelfDepartureActive()).toBe(true);

      releaseSettle();
      await running;
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it.each<[string, Res]>([
      ["a server error", { error: { code: "SERVER_ERROR", message: "x" } }],
      [
        "an already-left code",
        { error: { code: "MEMBER_NOT_FOUND", message: "x" } },
      ],
      ["a rate limit", { error: { code: "RATE_LIMITED", message: "x" } }],
    ])("does not resend on %s", async (_label, res) => {
      const send = vi.fn(async () => res);
      const settle = vi.fn();

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(res);
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("lifts the mark for exactly one resend after UNAUTHORIZED, then re-arms it for settle", async () => {
      const activeDuringSend: boolean[] = [];
      const send = vi
        .fn<() => Promise<Res>>()
        .mockImplementationOnce(async () => {
          activeDuringSend.push(await isSelfDepartureActive());
          return UNAUTHORIZED;
        })
        .mockImplementationOnce(async () => {
          activeDuringSend.push(await isSelfDepartureActive());
          return OK;
        });
      let activeDuringSettle: boolean | undefined;
      const settle = vi.fn(async () => {
        activeDuringSettle = await isSelfDepartureActive();
      });

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(2);
      expect(activeDuringSend).toEqual([true, false]);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
      expect(activeDuringSettle).toBe(true);
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("settles a second UNAUTHORIZED without a third send", async () => {
      const send = vi.fn(async () => UNAUTHORIZED);
      const settle = vi.fn();

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(2);
      expect(settle).toHaveBeenCalledWith(UNAUTHORIZED);
      expect(await isSelfDepartureActive()).toBe(false);
    });

    it("clears the mark and propagates when the first send throws", async () => {
      const send = vi.fn(async (): Promise<Res> => {
        throw new Error("network down");
      });
      const settle = vi.fn();

      await expect(runGuardedDeparture(send, settle)).rejects.toThrow(
        "network down",
      );

      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).not.toHaveBeenCalled();
      expect(await storedMark()).toBeUndefined();
    });

    it("clears the mark and propagates when the resend throws", async () => {
      const send = vi
        .fn<() => Promise<Res>>()
        .mockResolvedValueOnce(UNAUTHORIZED)
        .mockRejectedValueOnce(new Error("network down"));
      const settle = vi.fn();

      await expect(runGuardedDeparture(send, settle)).rejects.toThrow(
        "network down",
      );

      expect(send).toHaveBeenCalledTimes(2);
      expect(settle).not.toHaveBeenCalled();
      expect(await storedMark()).toBeUndefined();
    });

    it("clears the mark and propagates when settle rejects", async () => {
      const settle = vi.fn(async () => {
        throw new Error("settle failed");
      });

      await expect(runGuardedDeparture(async () => OK, settle)).rejects.toThrow(
        "settle failed",
      );

      expect(await storedMark()).toBeUndefined();
    });

    it("resolves when settle cleared the whole storage (account deletion)", async () => {
      const settle = vi.fn(async () => {
        await chrome.storage.local.clear();
      });

      await expect(
        runGuardedDeparture(async () => OK, settle),
      ).resolves.toBeUndefined();

      expect(await storedMark()).toBeUndefined();
    });

    it("still sends and settles when the mark cannot be written", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
        new Error("quota"),
      );
      const send = vi.fn(async () => OK);
      const settle = vi.fn();

      await expect(runGuardedDeparture(send, settle)).resolves.toBeUndefined();

      // A refused write costs the guard, never the leave itself.
      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
    });
  });
});
