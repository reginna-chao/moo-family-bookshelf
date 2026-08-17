import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { SYNC_CODE_HOST_SETTLE_DELAY_MS } from "moo-family-bookshelf-shared/api/syncCodeHost";
import { useSyncCodeHostVerdict } from "@/dialog/useSyncCodeHostVerdict";
import { parseSyncCodeApiHost } from "@/crypto/syncCode";
import {
  HALF_TYPED_PREFIXES,
  LAN_CODE,
  LAN_ENDPOINT,
  NO_HOST_CODE,
  SPOOFED_CODE,
  SPOOF_TAILS,
  TRUSTED_CODE,
  TRUSTED_ENDPOINT,
} from "../helpers/syncCodeHostFixtures";

/**
 * useSyncCodeHostVerdict decides WHEN the `@host` disclosure may reach the user
 * for a live sync-code field. It is the timing half of a security control: the
 * `invalid` warning is the last human-facing defence against a userinfo-spoofed
 * endpoint, and it used to flicker through nearly every keystroke of a
 * half-typed `@host` — which trains people to dismiss it.
 *
 * So the contract has two halves, and the second one is the dangerous one:
 *   - the warning may be DELAYED until the value settles;
 *   - it may never be SUPPRESSED, and nothing that contradicts the current
 *     value may stay on screen in its place.
 *
 * Twin of pwa/tests/unit/hooks/useSyncCodeHostVerdict.test.ts — the two apps
 * share the policy in `shared/` precisely so they cannot drift, so the coverage
 * is kept symmetric too, and the hooks themselves are held identical by
 * tests/unit/useSyncCodeHostVerdict.parity.test.ts — a file-level comparison
 * this suite runs its OWN copy of, so it also fires on a PR that touches
 * nothing but the Extension. All timing runs on fake timers; every test
 * restores real ones.
 *
 * Codes come from tests/helpers/syncCodeHostFixtures.ts so the Extension and
 * the PWA drive the same values through the same policy.
 */

function renderVerdict(code = "") {
  return renderHook(
    ({ code }: { code: string }) => useSyncCodeHostVerdict(code),
    { initialProps: { code } },
  );
}

function advanceSettleDelay(): void {
  act(() => {
    vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS);
  });
}

describe("useSyncCodeHostVerdict", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("while the value is still moving", () => {
    it.each(HALF_TYPED_PREFIXES)("says nothing about %s", (code) => {
      // The prefix really would warn if the verdict went straight to the screen.
      expect(parseSyncCodeApiHost(code)).toEqual({ kind: "invalid" });

      const { result, rerender } = renderVerdict();
      rerender({ code });

      expect(result.current.result).toEqual({ kind: "none" });
    });

    it("stays silent through a whole @host typed one character at a time", () => {
      const { result, rerender } = renderVerdict();

      for (const code of HALF_TYPED_PREFIXES) {
        rerender({ code });
        expect(result.current.result).toEqual({ kind: "none" });
        // A keystroke lands well inside the settle window, restarting it.
        act(() => {
          vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS / 10);
        });
        expect(result.current.result).toEqual({ kind: "none" });
      }

      // Anchor against a vacuous pass: the hook DOES report once the value is a
      // complete, adoptable endpoint, so the silence above is the delay doing
      // its job — not a hook that reports nothing whatever it is handed.
      rerender({ code: LAN_CODE });
      expect(result.current.result).toEqual({
        kind: "valid",
        endpoint: LAN_ENDPOINT,
      });
    });

    it("restarts the delay on every keystroke, so a slow typist is never interrupted", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: "moo-ab12-cd34@http" });
      act(() => {
        vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS - 1);
      });
      expect(result.current.result).toEqual({ kind: "none" });

      rerender({ code: "moo-ab12-cd34@http:" });
      act(() => {
        vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS - 1);
      });
      expect(result.current.result).toEqual({ kind: "none" });

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.result).toEqual({ kind: "invalid" });
    });

    it("never reports a verdict the current value does not hold", () => {
      const { result, rerender } = renderVerdict();

      for (const code of [...HALF_TYPED_PREFIXES, LAN_CODE, SPOOFED_CODE]) {
        rerender({ code });

        const displayed = result.current.result;
        if (displayed.kind !== "none") {
          expect(displayed).toEqual(parseSyncCodeApiHost(code));
        }
      }
    });
  });

  describe("settle trigger: the value holds still", () => {
    it("raises the warning once the value has held still for the settle delay", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      expect(result.current.result).toEqual({ kind: "none" });

      advanceSettleDelay();

      expect(result.current.result).toEqual({ kind: "invalid" });
    });
  });

  describe("settle trigger: paste", () => {
    it("raises the warning as soon as the pasted value lands, with no delay", () => {
      const { result, rerender } = renderVerdict();

      // onPaste fires BEFORE the input value updates, so the flag arms the NEXT
      // value rather than settling the (still empty) current one.
      act(() => result.current.settleOnNextChange());
      rerender({ code: SPOOFED_CODE });

      expect(result.current.result).toEqual({ kind: "invalid" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("arms the value that arrives, not the one already in the field", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: "moo-ab12-cd34@http://192.168." });
      act(() => result.current.settleOnNextChange());
      // Nothing has arrived yet — the half-typed value must stay silent.
      expect(result.current.result).toEqual({ kind: "none" });

      rerender({ code: SPOOFED_CODE });
      expect(result.current.result).toEqual({ kind: "invalid" });
    });

    it("does not leave the flag armed for a later keystroke once settleNow ran", () => {
      // A paste of text identical to the field's contents fires onPaste but
      // produces no change, so the flag is never consumed; blurring must disarm
      // it, otherwise the next keystroke would settle instantly and flicker.
      const { result, rerender } = renderVerdict();

      act(() => result.current.settleOnNextChange());
      act(() => result.current.settleNow());

      rerender({ code: SPOOFED_CODE });
      expect(result.current.result).toEqual({ kind: "none" });

      advanceSettleDelay();
      expect(result.current.result).toEqual({ kind: "invalid" });
    });
  });

  describe("settle trigger: blur / submit / join press", () => {
    it("raises the warning on settleNow, with no delay", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      expect(result.current.result).toEqual({ kind: "none" });

      act(() => result.current.settleNow());

      expect(result.current.result).toEqual({ kind: "invalid" });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  /**
   * The longest path a real user walks, and the only one that moves the settled
   * value back and forth across the `=== code` boundary: the warning is already
   * on screen, they go back into the field to fix the address, and every
   * keystroke of the correction must retract the warning again — then bring it
   * back if the result is still wrong.
   *
   * A hook that settled ONCE and stayed settled would pass every other test in
   * this file while flashing the warning through the whole correction.
   */
  describe("editing a value that has already settled", () => {
    it("re-hides the warning while the user edits a settled value, then brings it back", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      act(() => result.current.settleNow()); // blur: the warning is now showing
      expect(result.current.result).toEqual({ kind: "invalid" });

      // Back into the field, still mistyped: the warning must step aside again
      // rather than nag through the correction.
      rerender({ code: `${SPOOFED_CODE}/` });
      expect(result.current.result).toEqual({ kind: "none" });

      advanceSettleDelay();
      expect(result.current.result).toEqual({ kind: "invalid" });
    });

    it("names the endpoint at once when the correction lands on a good host", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      advanceSettleDelay();
      expect(result.current.result).toEqual({ kind: "invalid" });

      // The successful ending of the same journey: `valid` is positive
      // information about the current value, so the fix is acknowledged with no
      // timer advance at all, even though the field had settled on a warning a
      // moment ago.
      rerender({ code: LAN_CODE });

      expect(result.current.result).toEqual({
        kind: "valid",
        endpoint: LAN_ENDPOINT,
      });
    });
  });

  describe("settle trigger: a code present at first render (invite-link prefill)", () => {
    it("warns immediately for a prefilled spoofed code, with no delay", () => {
      // A prefill was never typed, so there is no typing to flicker through.
      const { result } = renderVerdict(SPOOFED_CODE);

      expect(result.current.result).toEqual({ kind: "invalid" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("names a prefilled adoptable endpoint immediately", () => {
      const { result } = renderVerdict(TRUSTED_CODE);

      expect(result.current.result).toEqual({
        kind: "valid",
        endpoint: TRUSTED_ENDPOINT,
      });
    });
  });

  describe("an adoptable @host is never delayed", () => {
    it.each([
      ["a public HTTPS endpoint", TRUSTED_CODE, TRUSTED_ENDPOINT],
      ["a LAN self-hosted endpoint", LAN_CODE, LAN_ENDPOINT],
    ])("names %s the moment it is typed", (_label, code, endpoint) => {
      const { result, rerender } = renderVerdict();

      rerender({ code });

      expect(result.current.result).toEqual({ kind: "valid", endpoint });
    });

    it("says nothing for a code that carries no @host", () => {
      const { result, rerender } = renderVerdict();

      rerender({ code: NO_HOST_CODE });

      expect(result.current.result).toEqual({ kind: "none" });
    });
  });

  /**
   * The most important case in this file. A note that survives the value it
   * described is worse than no note: "will connect to api.moofamily.app" left
   * standing over a field reading `…@evil.com` lends the spoof exactly the
   * legitimacy the warning exists to deny. So the withheld state must render
   * NOTHING, not the last verdict.
   */
  describe("the stale-valid hazard", () => {
    it("drops the named endpoint the instant the value turns invalid", () => {
      const { result, rerender } = renderVerdict(TRUSTED_CODE);
      expect(result.current.result).toEqual({
        kind: "valid",
        endpoint: TRUSTED_ENDPOINT,
      });

      rerender({ code: SPOOFED_CODE });

      // Before the delay elapses: nothing at all, and above all not the host
      // that was legitimate one keystroke ago.
      expect(result.current.result).toEqual({ kind: "none" });
      expect(JSON.stringify(result.current.result)).not.toContain(
        "api.moofamily.app",
      );
      expect(JSON.stringify(result.current.result)).not.toContain("evil.com");

      advanceSettleDelay();
      expect(result.current.result).toEqual({ kind: "invalid" });
    });

    it("drops it just as fast when the spoof tail is typed one character at a time", () => {
      const { result, rerender } = renderVerdict(TRUSTED_CODE);

      for (const tail of SPOOF_TAILS) {
        rerender({ code: `${TRUSTED_CODE}${tail}` });
        expect(result.current.result).toEqual({ kind: "none" });
      }

      advanceSettleDelay();
      expect(result.current.result).toEqual({ kind: "invalid" });
    });
  });

  describe("cleanup", () => {
    it("clears a pending settle timer on unmount instead of firing after it", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { rerender, unmount } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(SYNC_CODE_HOST_SETTLE_DELAY_MS * 10);
      });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("arms no timer at all once the value has settled", () => {
      const { rerender } = renderVerdict();

      rerender({ code: SPOOFED_CODE });
      advanceSettleDelay();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
