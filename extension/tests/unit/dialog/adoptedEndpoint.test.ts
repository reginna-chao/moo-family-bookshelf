import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyAdoptedEndpoint } from "@/dialog/adoptedEndpoint";
import { ApiClient, validateEndpointUrl } from "@/api/client";
import { DEFAULT_API_ENDPOINT } from "@/constants";

/**
 * `classifyAdoptedEndpoint` is the single authoritative answer to one question
 * that TWO screens ask: before the user types a PIN / pattern, which server is
 * about to receive it? The onboarding verification challenge
 * (extension/src/dialog/Onboarding.tsx) and the re-auth modal
 * (extension/src/dialog/ReauthModal.tsx) previously each carried a verbatim copy
 * of the same rule; two copies of a security disclosure are two chances to
 * answer the same question differently, which is exactly what the extraction
 * removes. This file is where that one answer is pinned.
 *
 * The two invariants it carries:
 *
 *   1. The official default endpoint discloses NOTHING (`kind: "none"`). A
 *      banner above every single challenge trains the user to scroll past the
 *      one time it means something; the disclosure is worth attention only when
 *      the destination is not the project's own Worker.
 *   2. Any other adopted endpoint is disclosed in CANONICAL form — byte-equal to
 *      `apiClient.getEndpoint()`, i.e. exactly where the secret is really going,
 *      never a prettier or differently-spelled address.
 *
 * Both are exercised through a REAL `ApiClient`, whose constructor / `setEndpoint`
 * run the very `validateEndpointUrl` that production adoption runs. A
 * hand-written stub could hold an endpoint production would never accept, which
 * would make the "valid" cases below prove less than they appear to.
 *
 * The `invalid` verdict is DEFENSIVE only: `ApiClient` refuses such a value at
 * both entry points, so no production path can reach it. The block below reaches
 * it by stubbing the getter, because "the reassuring line must never be attached
 * to a refused address" has to hold even if that assumption is ever broken.
 */

/** Cosmetic spellings a build env could produce; all canonicalize to the default. */
const DEFAULT_HOST = new URL(DEFAULT_API_ENDPOINT).hostname;
const SHOUTY_DEFAULT = DEFAULT_API_ENDPOINT.replace(
  DEFAULT_HOST,
  DEFAULT_HOST.toUpperCase(),
);

const CUSTOM_ENDPOINT = "https://custom.example.com";

describe("classifyAdoptedEndpoint", () => {
  // Safety net for the stubbed-getter block below; each case also restores its
  // own spy explicitly (see `withAdoptedEndpoint`).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("a client on the official default endpoint", () => {
    const defaultSpellings: Array<[string, string | undefined]> = [
      ["the default endpoint verbatim", DEFAULT_API_ENDPOINT],
      ["no endpoint at all (the constructor's own default)", undefined],
      ["a trailing-slash spelling of the default", `${DEFAULT_API_ENDPOINT}/`],
      ["an upper-case-host spelling of the default", SHOUTY_DEFAULT],
    ];

    it.each(defaultSpellings)("discloses nothing for %s", (_label, adopted) => {
      const client = new ApiClient(adopted);

      // Anchored on production: these spellings are the SAME endpoint only
      // because ApiClient canonicalizes them, which is what makes the
      // comparison inside classifyAdoptedEndpoint a whole-endpoint equality
      // rather than a string coincidence.
      expect(client.getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
      expect(classifyAdoptedEndpoint(client)).toEqual({ kind: "none" });
    });
  });

  describe("a client on a self-hosted endpoint", () => {
    it.each([
      [
        "an already-canonical host",
        CUSTOM_ENDPOINT,
        "https://custom.example.com",
      ],
      [
        "an upper-case host, lower-cased",
        "https://CUSTOM.Example.COM",
        "https://custom.example.com",
      ],
      [
        "an IDN host, folded to punycode",
        "https://пример.example",
        "https://xn--e1afmkfd.example",
      ],
      [
        "an explicit default port, dropped",
        "https://custom.example.com:443",
        "https://custom.example.com",
      ],
      [
        "a non-default port, kept",
        "https://custom.example.com:8443",
        "https://custom.example.com:8443",
      ],
      [
        "a trailing slash, stripped",
        "https://nas.example.com/moo/",
        "https://nas.example.com/moo",
      ],
      [
        "a sub-path, kept",
        "https://shared.example.com/family-a",
        "https://shared.example.com/family-a",
      ],
      [
        "a plain-HTTP LAN endpoint, scheme kept",
        "http://nas.local:8787",
        "http://nas.local:8787",
      ],
    ])("names it in canonical form — %s", (_label, adopted, expected) => {
      const client = new ApiClient(adopted);

      // Anchored on production twice over: the literal expectation is what
      // validateEndpointUrl produces, and it is what the client will actually
      // send the secret to. A disclosure that differs from either would be
      // vouching for an address the browser never visits.
      expect(expected).toBe(validateEndpointUrl(adopted));
      expect(expected).toBe(client.getEndpoint());
      expect(classifyAdoptedEndpoint(client)).toEqual({
        kind: "valid",
        endpoint: expected,
      });
    });

    it("discloses a sub-path on the default host as a custom endpoint", () => {
      // Same host, different path = a different backend. The verdict compares
      // the whole canonical endpoint, so this must not read as "the default".
      const subPath = `${DEFAULT_API_ENDPOINT}/self-hosted`;
      const client = new ApiClient(subPath);

      expect(classifyAdoptedEndpoint(client)).toEqual({
        kind: "valid",
        endpoint: validateEndpointUrl(subPath),
      });
    });
  });

  /**
   * The verdict is read from the client at call time, not captured once. It has
   * to be: `useEndpointSwitch` can adopt a family's endpoint on the live client
   * mid-session, and the re-auth modal may well render after that.
   */
  it("follows the client when the adopted endpoint changes mid-session", () => {
    const client = new ApiClient(DEFAULT_API_ENDPOINT);
    expect(classifyAdoptedEndpoint(client)).toEqual({ kind: "none" });

    client.setEndpoint(CUSTOM_ENDPOINT);

    expect(classifyAdoptedEndpoint(client)).toEqual({
      kind: "valid",
      endpoint: validateEndpointUrl(CUSTOM_ENDPOINT),
    });
  });

  /**
   * Unreachable through production: `ApiClient` rejects these in its constructor
   * AND in `setEndpoint`, which each case asserts before forcing the branch. The
   * coverage is deliberate anyway — the day that assumption breaks, the screen
   * must warn rather than attach the reassuring "will connect to …" line to an
   * address the user cannot trust.
   */
  describe("an adopted endpoint the client would refuse (defensive)", () => {
    /**
     * Force `getEndpoint()` to report a value production would never store,
     * restoring the real method even if the assertions inside throw.
     */
    function withAdoptedEndpoint<T>(
      client: ApiClient,
      endpoint: string,
      run: () => T,
    ): T {
      const spy = vi.spyOn(client, "getEndpoint").mockReturnValue(endpoint);
      try {
        return run();
      } finally {
        spy.mockRestore();
      }
    }

    it.each([
      ["a userinfo masquerade", "https://real.example@evil.com"],
      ["embedded user:password credentials", "https://user:pass@evil.com"],
      ["plain HTTP on a public host", "http://evil.example.com"],
      ["a non-HTTP scheme", "ftp://files.example.com"],
      ["a bare host with no scheme", "my-worker.example.com"],
    ])("refuses to vouch for %s", (_label, refused) => {
      // Why this branch is unreachable in production, asserted rather than
      // assumed — both adoption paths throw on the value being forced below.
      expect(() => new ApiClient(refused)).toThrow();
      const client = new ApiClient(CUSTOM_ENDPOINT);
      expect(() => client.setEndpoint(refused)).toThrow();

      const result = withAdoptedEndpoint(client, refused, () =>
        classifyAdoptedEndpoint(client),
      );

      expect(result).toEqual({ kind: "invalid" });
    });

    it("hands the UI no trace of the refused address", () => {
      const client = new ApiClient(CUSTOM_ENDPOINT);

      const result = withAdoptedEndpoint(
        client,
        "https://real.example@evil.com",
        () => classifyAdoptedEndpoint(client),
      );

      // `invalid` carries no `endpoint` field at all, so the warning copy has
      // nothing to echo: neither the masqueraded name nor the host it would
      // really reach. Reassurance lent to a spoofed address is worse than
      // silence.
      expect(result).toEqual({ kind: "invalid" });
      expect(JSON.stringify(result)).not.toContain("real.example");
      expect(JSON.stringify(result)).not.toContain("evil.com");
    });

    it("leaves the real client untouched once the stub is gone", () => {
      const client = new ApiClient(CUSTOM_ENDPOINT);

      withAdoptedEndpoint(client, "https://real.example@evil.com", () =>
        classifyAdoptedEndpoint(client),
      );

      // No leaked spy: the next screen to ask gets the genuine verdict.
      expect(client.getEndpoint()).toBe(CUSTOM_ENDPOINT);
      expect(classifyAdoptedEndpoint(client)).toEqual({
        kind: "valid",
        endpoint: CUSTOM_ENDPOINT,
      });
    });
  });
});
