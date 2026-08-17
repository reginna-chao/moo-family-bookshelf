import { describe, it, expect } from "vitest";
import {
  displayedSyncCodeApiHost,
  SYNC_CODE_HOST_SETTLE_DELAY_MS,
} from "moo-family-bookshelf-shared/api/syncCodeHost";
import {
  encodeSyncCode,
  decodeSyncCode,
  parseSyncCodeApiHost,
  SyncCodeError,
  type SyncCodeApiHostResult,
} from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";
import {
  HALF_TYPED_PREFIXES,
  SPOOF_TAILS,
  TRUSTED_CODE,
} from "../../helpers/syncCodeHostFixtures";

describe("encodeSyncCode", () => {
  it("should encode without API host", () => {
    const result = encodeSyncCode({
      familyId: "ab12-cd34",
    });
    expect(result).toBe("moo-ab12-cd34");
  });

  it("should encode with API host", () => {
    const result = encodeSyncCode({
      familyId: "ab12-cd34",
      apiHost: "my-worker.example.com",
    });
    expect(result).toBe("moo-ab12-cd34@my-worker.example.com");
  });
});

describe("decodeSyncCode", () => {
  it("should decode a standard sync code", () => {
    const result = decodeSyncCode("moo-ab12-cd34");
    expect(result).toEqual({
      familyId: "ab12-cd34",
      apiHost: undefined,
    });
  });

  it("should decode a sync code with API host", () => {
    const result = decodeSyncCode("moo-ab12-cd34@my-worker.example.com");
    expect(result).toEqual({
      familyId: "ab12-cd34",
      apiHost: "my-worker.example.com",
    });
  });

  it("should ignore trailing parts after familyId (backward compat)", () => {
    const result = decodeSyncCode("moo-ab12-cd34-key-part1-part2");
    expect(result).toEqual({
      familyId: "ab12-cd34",
      apiHost: undefined,
    });
  });

  it("should trim whitespace", () => {
    const result = decodeSyncCode("  moo-ab12-cd34  ");
    expect(result.familyId).toBe("ab12-cd34");
  });

  it("should throw on invalid prefix", () => {
    expect(() => decodeSyncCode("foo-ab12-cd34")).toThrow(SyncCodeError);
  });

  it("should throw on too few parts", () => {
    expect(() => decodeSyncCode("moo-ab12")).toThrow(SyncCodeError);
  });

  it("should throw on empty host after @", () => {
    expect(() => decodeSyncCode("moo-ab12-cd34@")).toThrow(SyncCodeError);
  });
});

/**
 * `parseSyncCodeApiHost` is the DISPLAY-only reader behind SyncCodeHostNote: it
 * runs on every keystroke while the user types a sync code, so it must never
 * throw on partial or malformed input — it just reports "no custom host".
 *
 * Security contract: what the note DISPLAYS must equal what the join path would
 * actually CONNECT to. The `@host` therefore goes through the same
 * `validateEndpointUrl` the join path adopts, and the reported value is that
 * function's canonical output (`origin + pathname`, trailing slashes stripped),
 * NOT a bare host — a plain-HTTP LAN address must not read the same as its
 * HTTPS namesake, and a sub-path endpoint must show the path it will call.
 *
 * The verdict itself comes from `shared/`, so the Extension's note and this one
 * cannot disagree about the same code; the Extension pins the identical table
 * in extension/tests/unit/syncCode.test.ts.
 */
describe("parseSyncCodeApiHost", () => {
  interface Case {
    name: string;
    input: string;
    expected: SyncCodeApiHostResult;
  }

  const cases: Case[] = [
    {
      name: "reports no host for a default-endpoint code",
      input: "moo-ab12-cd34",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for an empty string",
      input: "",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for a code still being typed",
      input: "moo-ab12",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for a dangling @ with nothing after it",
      input: "moo-ab12-cd34@",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for a wrong prefix",
      input: "foo-ab12-cd34@https://custom.dev",
      expected: { kind: "none" },
    },
    {
      name: "reads a full HTTPS URL after @",
      input: "moo-ab12-cd34@https://custom.example.com",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      name: "keeps the path of a sub-path endpoint",
      input: "moo-ab12-cd34@https://custom.example.com/api",
      expected: { kind: "valid", endpoint: "https://custom.example.com/api" },
    },
    {
      name: "strips a trailing slash",
      input: "moo-ab12-cd34@https://custom.example.com/api/",
      expected: { kind: "valid", endpoint: "https://custom.example.com/api" },
    },
    {
      name: "lowercases an upper-case host",
      input: "moo-ab12-cd34@https://CUSTOM.Example.COM",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      // A homograph attack relies on the unicode spelling LOOKING like a host
      // the user trusts; the punycode form is what exposes it.
      name: "shows an IDN host in punycode",
      input: "moo-ab12-cd34@https://пример.example",
      expected: { kind: "valid", endpoint: "https://xn--e1afmkfd.example" },
    },
    {
      name: "reads a localhost dev endpoint",
      input: "moo-ab12-cd34@http://localhost:8787",
      expected: { kind: "valid", endpoint: "http://localhost:8787" },
    },
    {
      name: "rejects a userinfo masquerade",
      input: "moo-ab12-cd34@https://real.example@evil.com",
      expected: { kind: "invalid" },
    },
    {
      name: "rejects embedded user:password credentials",
      input: "moo-ab12-cd34@https://user:pass@evil.com",
      expected: { kind: "invalid" },
    },
    {
      name: "rejects plain HTTP on a public host",
      input: "moo-ab12-cd34@http://evil.example.com",
      expected: { kind: "invalid" },
    },
    {
      name: "rejects a non-HTTP scheme",
      input: "moo-ab12-cd34@ftp://files.example.com",
      expected: { kind: "invalid" },
    },
    {
      // `new URL()` cannot parse a scheme-less host, so adoption always threw.
      name: "rejects a bare host with no scheme",
      input: "moo-ab12-cd34@my-worker.example.com",
      expected: { kind: "invalid" },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(parseSyncCodeApiHost(input)).toEqual(expected);
  });

  it.each([
    "https://custom.example.com",
    "https://CUSTOM.Example.COM",
    "https://пример.example",
    "https://custom.example.com:443",
    "https://custom.example.com/api/",
    "http://localhost:8787",
  ])("reports exactly the endpoint %s would be adopted as", (endpoint) => {
    expect(parseSyncCodeApiHost(`moo-ab12-cd34@${endpoint}`)).toEqual({
      kind: "valid",
      endpoint: validateEndpointUrl(endpoint),
    });
  });

  it("never reports an endpoint for a credential-bearing URL", () => {
    const result = parseSyncCodeApiHost(
      "moo-ab12-cd34@https://real.example@evil.com",
    );

    // Reporting it as `valid` — with EITHER spelling — would lend the spoof
    // legitimacy, so the only safe answer is "invalid".
    expect(result).toEqual({ kind: "invalid" });
    expect(JSON.stringify(result)).not.toContain("real.example");
    expect(JSON.stringify(result)).not.toContain("evil.com");
  });

  it("never throws on input that decodeSyncCode rejects", () => {
    expect(() => decodeSyncCode("moo-ab12")).toThrow(SyncCodeError);
    expect(() => parseSyncCodeApiHost("moo-ab12")).not.toThrow();
  });

  it("never throws on an @host that validateEndpointUrl rejects", () => {
    expect(() => validateEndpointUrl("my-worker.example.com")).toThrow();
    expect(() =>
      parseSyncCodeApiHost("moo-ab12-cd34@my-worker.example.com"),
    ).not.toThrow();
  });
});

/**
 * `displayedSyncCodeApiHost` is the DISPLAY POLICY stacked on top of the
 * classifier: given the LIVE verdict for whatever the field holds right now and
 * whether that value has SETTLED, it answers what may actually be rendered.
 *
 * Why a policy exists at all: a `@host` typed one character at a time is
 * `invalid` at nearly every intermediate keystroke (`…@http`, `…@http://192.`),
 * so a live warning fires on almost every keypress. A warning that cries wolf
 * during normal typing is one users learn to dismiss — fatal here, because this
 * warning is the last human-facing defence against a userinfo-spoofed endpoint.
 *
 * Two properties matter more than any individual row below:
 *   - only `invalid` is ever withheld; `valid` and `none` pass through live, so
 *     the delay can never SUPPRESS a warning, only postpone it;
 *   - the withheld case renders NOTHING rather than the previously shown
 *     verdict. Keeping a stale `valid` note on screen would leave a reassuring
 *     "will connect to api.moofamily.app" standing for a value that now reads
 *     `…@evil.com` — the exact legitimacy the warning exists to deny.
 *
 * The policy lives in `shared/` so the PWA and the Extension cry wolf at the
 * same moment; the Extension pins the identical table in
 * extension/tests/unit/syncCode.test.ts.
 */
describe("displayedSyncCodeApiHost", () => {
  const VALID: SyncCodeApiHostResult = {
    kind: "valid",
    endpoint: "https://custom.example.com",
  };

  interface Case {
    name: string;
    live: SyncCodeApiHostResult;
    settled: boolean;
    expected: SyncCodeApiHostResult;
  }

  const cases: Case[] = [
    {
      name: "renders nothing for a code with no @host, while it is still moving",
      live: { kind: "none" },
      settled: false,
      expected: { kind: "none" },
    },
    {
      name: "renders nothing for a code with no @host, once it has settled",
      live: { kind: "none" },
      settled: true,
      expected: { kind: "none" },
    },
    {
      name: "names an adoptable @host immediately, before the value settles",
      live: VALID,
      settled: false,
      expected: VALID,
    },
    {
      name: "keeps naming an adoptable @host once the value has settled",
      live: VALID,
      settled: true,
      expected: VALID,
    },
    {
      name: "withholds the warning for a refused @host while the value is still moving",
      live: { kind: "invalid" },
      settled: false,
      expected: { kind: "none" },
    },
    {
      name: "raises the warning for a refused @host once the value has settled",
      live: { kind: "invalid" },
      settled: true,
      expected: { kind: "invalid" },
    },
  ];

  it.each(cases)("$name", ({ live, settled, expected }) => {
    expect(displayedSyncCodeApiHost(live, settled)).toEqual(expected);
  });

  /**
   * The anti-stale invariant, stated as a property rather than a row: the only
   * two answers the policy may give are the CURRENT verdict verbatim or
   * "render nothing". Anything else would be a claim about the field that the
   * field does not currently support.
   */
  it.each(cases)(
    "$name — and returns either the live verdict itself or nothing",
    ({ live, settled }) => {
      const displayed = displayedSyncCodeApiHost(live, settled);

      if (displayed.kind !== "none") {
        expect(displayed).toBe(live);
      }
    },
  );

  /**
   * Half-typed prefixes of a legitimate LAN endpoint, from the fixture both
   * apps share. Each one is genuinely `invalid` — which is precisely why a live
   * warning used to flash through the whole run — and each must stay silent
   * until the value stops moving.
   */
  it.each(HALF_TYPED_PREFIXES)(
    "stays silent for the half-typed %s until it settles",
    (code) => {
      const live = parseSyncCodeApiHost(code);

      // The case is only meaningful because the LIVE verdict really is a warning.
      expect(live).toEqual({ kind: "invalid" });
      expect(displayedSyncCodeApiHost(live, false)).toEqual({ kind: "none" });
      expect(displayedSyncCodeApiHost(live, true)).toEqual({ kind: "invalid" });
    },
  );

  /**
   * The stale-valid hazard at policy level: appending `@evil.com` to a host the
   * user already saw named turns the verdict invalid, and the policy must
   * answer "nothing" — never the endpoint that was legitimate one keystroke ago.
   */
  it.each(SPOOF_TAILS.map((tail) => `${TRUSTED_CODE}${tail}`))(
    "never echoes the pre-spoof host for %s",
    (code) => {
      const displayed = displayedSyncCodeApiHost(
        parseSyncCodeApiHost(code),
        false,
      );

      expect(displayed).toEqual({ kind: "none" });
      expect(JSON.stringify(displayed)).not.toContain("api.moofamily.app");
      expect(JSON.stringify(displayed)).not.toContain("evil.com");
    },
  );

  /**
   * The delay is a UX knob, but not a free one: long enough to cover typing an
   * `@host`, short enough that the warning still lands well before the user
   * commits. Pinning the bounds (not the number) keeps a future tuning honest.
   */
  it("delays the warning by a short, positive interval", () => {
    expect(Number.isInteger(SYNC_CODE_HOST_SETTLE_DELAY_MS)).toBe(true);
    expect(SYNC_CODE_HOST_SETTLE_DELAY_MS).toBeGreaterThan(0);
    expect(SYNC_CODE_HOST_SETTLE_DELAY_MS).toBeLessThanOrEqual(2000);
  });
});

describe("roundtrip", () => {
  it("should encode then decode back to the same data", () => {
    const original = {
      familyId: "fa99-bc01",
      apiHost: "custom.workers.dev",
    };
    const encoded = encodeSyncCode(original);
    const decoded = decodeSyncCode(encoded);
    expect(decoded).toEqual(original);
  });

  it("should roundtrip without API host", () => {
    const original = {
      familyId: "fa99-bc01",
    };
    const encoded = encodeSyncCode(original);
    const decoded = decodeSyncCode(encoded);
    expect(decoded.familyId).toBe(original.familyId);
    expect(decoded.apiHost).toBeUndefined();
  });
});
