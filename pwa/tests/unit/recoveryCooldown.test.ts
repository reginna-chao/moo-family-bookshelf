import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getActiveRecoveryCooldown,
  setRecoveryCooldown,
  clearRecoveryCooldown,
  RECOVERY_COOLDOWN_UNTIL_KEY,
  DEFAULT_RECOVERY_COOLDOWN_SECONDS,
  MAX_RECOVERY_COOLDOWN_SECONDS,
} from "@/utils/recoveryCooldown";

/** Pinned clock so deadlines can be asserted exactly. */
const NOW = 1_700_000_000_000;

describe("recoveryCooldown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(RECOVERY_COOLDOWN_UNTIL_KEY);
  });

  describe("getActiveRecoveryCooldown", () => {
    it("returns the deadline written by setRecoveryCooldown while it is active", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const written = setRecoveryCooldown(60);
      expect(getActiveRecoveryCooldown()).toBe(written);
    });

    it.each([
      ["missing key", null],
      ["expired deadline", String(NOW - 1000)],
      ["garbage string", "not-a-number"],
      ["empty string", ""],
    ])("returns undefined for %s", (_label, stored) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      if (stored !== null) {
        localStorage.setItem(RECOVERY_COOLDOWN_UNTIL_KEY, stored);
      }
      expect(getActiveRecoveryCooldown()).toBeUndefined();
    });

    it("clamps a stored deadline beyond the max and self-heals the persisted value", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      // 10 hours out — e.g. persisted before the write-side cap existed.
      localStorage.setItem(
        RECOVERY_COOLDOWN_UNTIL_KEY,
        String(NOW + 10 * 3600 * 1000),
      );
      const clamped = NOW + MAX_RECOVERY_COOLDOWN_SECONDS * 1000;
      expect(getActiveRecoveryCooldown()).toBe(clamped);
      // Liveness guarantee: the inflated value must be rewritten in storage,
      // otherwise the cooldown keeps sliding (now + max) and outlives the cap.
      expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBe(
        String(clamped),
      );
    });

    it("still returns the clamped value when the self-heal write throws", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      // Seed BEFORE spying so the inflated value actually lands in storage.
      localStorage.setItem(
        RECOVERY_COOLDOWN_UNTIL_KEY,
        String(NOW + 10 * 3600 * 1000),
      );
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
      let result: number | undefined;
      expect(() => {
        result = getActiveRecoveryCooldown();
      }).not.toThrow();
      expect(result).toBe(NOW + MAX_RECOVERY_COOLDOWN_SECONDS * 1000);
    });

    it("returns undefined instead of throwing when storage read throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      expect(getActiveRecoveryCooldown()).toBeUndefined();
    });
  });

  describe("setRecoveryCooldown", () => {
    it.each([
      {
        label: "undefined",
        retryAfter: undefined,
        expectedSeconds: DEFAULT_RECOVERY_COOLDOWN_SECONDS,
      },
      {
        label: "NaN",
        retryAfter: NaN,
        expectedSeconds: DEFAULT_RECOVERY_COOLDOWN_SECONDS,
      },
      {
        label: "negative (-5)",
        retryAfter: -5,
        expectedSeconds: DEFAULT_RECOVERY_COOLDOWN_SECONDS,
      },
      {
        label: "zero",
        retryAfter: 0,
        expectedSeconds: DEFAULT_RECOVERY_COOLDOWN_SECONDS,
      },
      {
        label: "Infinity",
        retryAfter: Infinity,
        expectedSeconds: DEFAULT_RECOVERY_COOLDOWN_SECONDS,
      },
      { label: "a normal value (60)", retryAfter: 60, expectedSeconds: 60 },
      {
        label: "an excessive value (999999)",
        retryAfter: 999999,
        expectedSeconds: MAX_RECOVERY_COOLDOWN_SECONDS,
      },
    ])(
      "persists a $expectedSeconds s deadline when retryAfter is $label",
      ({ retryAfter, expectedSeconds }) => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        const deadline = setRecoveryCooldown(retryAfter);
        expect(deadline).toBe(NOW + expectedSeconds * 1000);
        expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBe(
          String(deadline),
        );
      },
    );

    it("still returns a deadline and does not throw when storage write throws", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("quota");
      });
      let deadline: number | undefined;
      expect(() => {
        deadline = setRecoveryCooldown();
      }).not.toThrow();
      expect(deadline).toBe(NOW + DEFAULT_RECOVERY_COOLDOWN_SECONDS * 1000);
    });
  });

  describe("clearRecoveryCooldown", () => {
    it("removes an active cooldown", () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setRecoveryCooldown(60);
      clearRecoveryCooldown();
      expect(localStorage.getItem(RECOVERY_COOLDOWN_UNTIL_KEY)).toBeNull();
      expect(getActiveRecoveryCooldown()).toBeUndefined();
    });

    it("does not throw when storage removal throws", () => {
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("denied");
      });
      expect(() => clearRecoveryCooldown()).not.toThrow();
    });
  });
});
