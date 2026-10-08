import { describe, it, expect, vi, afterEach } from "vitest";
import type { ApiResponse } from "moo-family-bookshelf-shared/api/types";
import {
  beginSelfDeparture,
  isSelfDepartureActive,
  runGuardedDeparture,
  SELF_DEPARTURE_TTL_MS,
  SELF_DEPARTURE_UNTIL_KEY,
} from "@/utils/selfDeparture";

/**
 * The "own leave / delete-account request in flight" mark (#263). While it is
 * active, App's silent recovery join stays off (`hooks/recoveryJoinGate.ts`),
 * so a 401 raised mid-departure cannot re-add the user to the family they are
 * leaving. Every storage failure is swallowed in the direction that keeps the
 * user unblocked: a refused write costs the guard, never the leave; an
 * unreadable store reads as "not departing". Twin of
 * `extension/tests/unit/storage/selfDeparture.test.ts`.
 */

/** Pinned clock so deadlines can be asserted exactly. */
const NOW = 1_700_000_000_000;

type Res = ApiResponse<{ ok: boolean }>;
const OK: Res = { data: { ok: true } };
const UNAUTHORIZED: Res = {
  error: { code: "UNAUTHORIZED", message: "token revoked" },
};

describe("selfDeparture", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);
  });

  describe("beginSelfDeparture / isSelfDepartureActive", () => {
    it("writes a deadline one TTL ahead and reads as active until cleanup", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      expect(SELF_DEPARTURE_TTL_MS).toBe(60_000);

      const end = beginSelfDeparture();

      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBe(
        String(NOW + SELF_DEPARTURE_TTL_MS),
      );
      expect(isSelfDepartureActive()).toBe(true);

      end();

      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
      expect(isSelfDepartureActive()).toBe(false);
    });

    it("is inactive when no mark was ever written", () => {
      expect(isSelfDepartureActive()).toBe(false);
    });

    it("expires on its own after the TTL when the cleanup never runs", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      beginSelfDeparture(); // cleanup deliberately dropped: the tab "died"

      vi.advanceTimersByTime(SELF_DEPARTURE_TTL_MS - 1);
      expect(isSelfDepartureActive()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(isSelfDepartureActive()).toBe(false);
    });

    it("ignores a deadline left further ahead than the TTL by a clock moved back", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      beginSelfDeparture();

      // The device clock jumps back a minute: the stored deadline now sits
      // two TTLs ahead and must not block recovery for that long.
      vi.setSystemTime(NOW - SELF_DEPARTURE_TTL_MS);

      expect(isSelfDepartureActive()).toBe(false);
    });

    it.each([
      ["garbage string", "not-a-number"],
      ["empty string", ""],
      ["already expired", String(NOW - 1)],
      ["exactly now", String(NOW)],
    ])("reads a stored %s as inactive", (_label, stored) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      localStorage.setItem(SELF_DEPARTURE_UNTIL_KEY, stored);

      expect(isSelfDepartureActive()).toBe(false);
    });

    it("reads as inactive instead of throwing when the storage read throws", () => {
      localStorage.setItem(
        SELF_DEPARTURE_UNTIL_KEY,
        String(Date.now() + 30_000),
      );
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });

      expect(isSelfDepartureActive()).toBe(false);
    });

    it("still returns a working cleanup when the storage write throws", () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });

      let end!: () => void;
      expect(() => {
        end = beginSelfDeparture();
      }).not.toThrow();
      expect(isSelfDepartureActive()).toBe(false);
      expect(() => end()).not.toThrow();
    });

    it("swallows a storage failure inside the cleanup", () => {
      const end = beginSelfDeparture();
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("denied");
      });

      expect(() => end()).not.toThrow();
    });

    it("leaves a later departure's mark in place when an earlier one cleans up", () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const endFirst = beginSelfDeparture();
      // A second tab starts its own departure a moment later, overwriting.
      now.mockReturnValue(NOW + 5);
      const endSecond = beginSelfDeparture();
      const secondValue = String(NOW + 5 + SELF_DEPARTURE_TTL_MS);

      endFirst();

      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBe(secondValue);
      expect(isSelfDepartureActive()).toBe(true);

      endSecond();

      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
    });

    it("is a no-op when the mark was already removed by someone else", () => {
      const end = beginSelfDeparture();
      localStorage.removeItem(SELF_DEPARTURE_UNTIL_KEY);

      expect(() => end()).not.toThrow();
      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
    });
  });

  describe("runGuardedDeparture", () => {
    it("sends once with the mark active, settles under the mark, then clears it", async () => {
      const activeAt: Record<string, boolean> = {};
      const send = vi.fn(async () => {
        activeAt.send = isSelfDepartureActive();
        return OK;
      });
      const settle = vi.fn(() => {
        activeAt.settle = isSelfDepartureActive();
      });

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
      expect(activeAt).toEqual({ send: true, settle: true });
      expect(isSelfDepartureActive()).toBe(false);
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
      expect(isSelfDepartureActive()).toBe(false);
    });

    // Own 401: the mark blocked recovery, so the request is resent ONCE with the mark
    // lifted (the normal 401 → recovery join runs), then settled with it re-armed.
    it("lifts the mark for exactly one resend after UNAUTHORIZED, then re-arms it for settle", async () => {
      const activeDuringSend: boolean[] = [];
      const send = vi
        .fn<() => Promise<Res>>()
        .mockImplementationOnce(async () => {
          activeDuringSend.push(isSelfDepartureActive());
          return UNAUTHORIZED;
        })
        .mockImplementationOnce(async () => {
          activeDuringSend.push(isSelfDepartureActive());
          return OK;
        });
      let activeDuringSettle: boolean | undefined;
      const settle = vi.fn(() => {
        activeDuringSettle = isSelfDepartureActive();
      });

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(2);
      expect(activeDuringSend).toEqual([true, false]);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
      expect(activeDuringSettle).toBe(true);
      expect(isSelfDepartureActive()).toBe(false);
    });

    it("settles a second UNAUTHORIZED without a third send", async () => {
      const send = vi.fn(async () => UNAUTHORIZED);
      const settle = vi.fn();

      await runGuardedDeparture(send, settle);

      expect(send).toHaveBeenCalledTimes(2);
      expect(settle).toHaveBeenCalledWith(UNAUTHORIZED);
      expect(isSelfDepartureActive()).toBe(false);
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
      expect(isSelfDepartureActive()).toBe(false);
      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
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
      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
    });

    it("clears the mark and propagates when settle throws", async () => {
      const settle = vi.fn(() => {
        throw new Error("settle failed");
      });

      await expect(runGuardedDeparture(async () => OK, settle)).rejects.toThrow(
        "settle failed",
      );

      expect(localStorage.getItem(SELF_DEPARTURE_UNTIL_KEY)).toBeNull();
    });

    it("still sends and settles when the mark cannot be written", async () => {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
      const send = vi.fn(async () => OK);
      const settle = vi.fn();

      await expect(runGuardedDeparture(send, settle)).resolves.toBeUndefined();

      // A refused write costs the guard, never the leave itself.
      expect(send).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledWith(OK);
    });
  });
});
