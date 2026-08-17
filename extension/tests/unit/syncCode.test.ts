import { describe, it, expect } from "vitest";
import {
  encodeSyncCode,
  decodeSyncCode,
  parseSyncCodeApiHost,
  SyncCodeError,
  type SyncCodeApiHostResult,
} from "@/crypto/syncCode";
import { validateEndpointUrl } from "@/api/client";

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

  it("should accept old format with extra parts (backward compat) and ignore the key", () => {
    const result = decodeSyncCode("moo-abcd-1234-LONGKEY");
    expect(result).toEqual({
      familyId: "abcd-1234",
      apiHost: undefined,
    });
  });

  it("should accept old format with extra parts and @host", () => {
    const result = decodeSyncCode(
      "moo-abcd-1234-LONGKEY@my-worker.example.com",
    );
    expect(result).toEqual({
      familyId: "abcd-1234",
      apiHost: "my-worker.example.com",
    });
  });
});

/**
 * `parseSyncCodeApiHost` is the DISPLAY-only reader behind SyncCodeHostNote: it
 * runs on every keystroke while the user types a sync code, so it must never
 * throw on partial or malformed input — it just reports "no custom host".
 *
 * Security contract it now encodes: what the note DISPLAYS must equal what the
 * join path would actually CONNECT to. So the `@host` is run through the same
 * `validateEndpointUrl` the join path adopts, and the reported value is that
 * function's canonical output — `origin + pathname`, trailing slashes stripped,
 * NOT a bare host:
 *   - `valid`   → the code would be adopted, and `endpoint` is where it lands.
 *     Reporting the full endpoint (scheme and path included) is deliberate: a
 *     plain-HTTP LAN address must not read identically to its HTTPS namesake,
 *     and a sub-path endpoint must show the path it will really call.
 *   - `invalid` → the code would be REFUSED on adoption. Displaying the
 *     reassuring "will connect to …" line for such a value would lend a spoofed
 *     address false legitimacy, so the caller warns instead.
 *   - `none`    → no `@host`, or the code is not parseable yet.
 */
describe("parseSyncCodeApiHost", () => {
  interface Case {
    name: string;
    input: string;
    expected: SyncCodeApiHostResult;
  }

  const noneCases: Case[] = [
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
      name: "reports no host for the prefix alone",
      input: "moo-",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for a dangling @ with nothing after it",
      input: "moo-ab12-cd34@",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for a wrong prefix",
      input: "foo-ab12-cd34@custom.dev",
      expected: { kind: "none" },
    },
    {
      name: "reports no host for an empty family id",
      input: "moo--@custom.dev",
      expected: { kind: "none" },
    },
  ];

  const validCases: Case[] = [
    {
      name: "reads a full HTTPS URL after @",
      input: "moo-ab12-cd34@https://custom.example.com",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      name: "reads a localhost dev endpoint, keeping its non-default port",
      input: "moo-ab12-cd34@http://localhost:8787",
      expected: { kind: "valid", endpoint: "http://localhost:8787" },
    },
    {
      name: "reads a private-LAN dev endpoint",
      input: "moo-ab12-cd34@http://192.168.1.50:8787",
      expected: { kind: "valid", endpoint: "http://192.168.1.50:8787" },
    },
    {
      name: "ignores surrounding whitespace",
      input: "  moo-ab12-cd34@https://custom.example.com  ",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      name: "reads the endpoint of an old-format code with an extra key segment",
      input: "moo-abcd-1234-LONGKEY@https://custom.dev",
      expected: { kind: "valid", endpoint: "https://custom.dev" },
    },
    {
      // The user sees the host in the same case the browser resolves, so an
      // ALL-CAPS spelling cannot read as a different server than it is.
      name: "lowercases an upper-case host",
      input: "moo-ab12-cd34@https://CUSTOM.Example.COM",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      // A homograph attack relies on the unicode spelling LOOKING like a host
      // the user trusts. Displaying the punycode form is what exposes it.
      name: "shows an IDN host in punycode, not its unicode spelling",
      input: "moo-ab12-cd34@https://пример.example",
      expected: { kind: "valid", endpoint: "https://xn--e1afmkfd.example" },
    },
    {
      name: "drops an explicit default port",
      input: "moo-ab12-cd34@https://custom.example.com:443",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      name: "keeps a non-default port",
      input: "moo-ab12-cd34@https://custom.example.com:8443",
      expected: { kind: "valid", endpoint: "https://custom.example.com:8443" },
    },
    {
      // The path IS part of the endpoint the client will call, so a
      // host-only answer would under-report where the code points.
      name: "keeps the path of a sub-path endpoint",
      input: "moo-ab12-cd34@https://custom.example.com/api",
      expected: { kind: "valid", endpoint: "https://custom.example.com/api" },
    },
    {
      // Canonicalisation matches the ApiClient's own storage form, so the note
      // and the adopted endpoint are the same string.
      name: "strips a trailing slash",
      input: "moo-ab12-cd34@https://custom.example.com/",
      expected: { kind: "valid", endpoint: "https://custom.example.com" },
    },
    {
      name: "strips repeated trailing slashes after a path",
      input: "moo-ab12-cd34@https://custom.example.com/api//",
      expected: { kind: "valid", endpoint: "https://custom.example.com/api" },
    },
  ];

  /**
   * Every case here is a value the join path would REFUSE, so the note must not
   * present it as the server the code connects to.
   */
  const invalidCases: Case[] = [
    {
      // `new URL()` cannot parse a scheme-less host, so adoption always threw on
      // these; app-generated codes carry the full endpoint URL.
      name: "rejects a bare host with no scheme",
      input: "moo-ab12-cd34@my-worker.example.com",
      expected: { kind: "invalid" },
    },
    {
      name: "rejects a bare host in an old-format code",
      input: "moo-abcd-1234-LONGKEY@custom.dev",
      expected: { kind: "invalid" },
    },
    {
      // Everything after the FIRST @ is the host segment, so this is an
      // unparseable URL rather than two hosts.
      name: "rejects a second @ inside the host segment",
      input: "moo-ab12-cd34@host@extra.example",
      expected: { kind: "invalid" },
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
      name: "rejects a javascript: URL",
      input: "moo-ab12-cd34@javascript:alert(1)",
      expected: { kind: "invalid" },
    },
  ];

  it.each([...noneCases, ...validCases, ...invalidCases])(
    "$name",
    ({ input, expected }) => {
      expect(parseSyncCodeApiHost(input)).toEqual(expected);
    },
  );

  /**
   * The whole point of the `valid` branch: the string shown to the user is the
   * endpoint the client would actually adopt after `validateEndpointUrl`
   * canonicalizes the same segment. Derived from production here rather than
   * hard-coded, so the two cannot drift apart.
   */
  it.each([
    "https://custom.example.com",
    "https://CUSTOM.Example.COM",
    "https://пример.example",
    "https://custom.example.com:443",
    "https://custom.example.com/api",
    "https://custom.example.com/api/",
    "http://localhost:8787",
  ])("reports exactly the endpoint %s would be adopted as", (endpoint) => {
    const result = parseSyncCodeApiHost(`moo-ab12-cd34@${endpoint}`);

    expect(result.kind).toBe("valid");
    expect(result).toEqual({
      kind: "valid",
      endpoint: validateEndpointUrl(endpoint),
    });
  });

  /**
   * Host-only reporting used to collapse these two into the same string. They
   * are different servers as far as transport security goes, so the value the
   * note renders must tell them apart.
   */
  it("distinguishes a plain-HTTP LAN endpoint from its HTTPS namesake", () => {
    const plain = parseSyncCodeApiHost(
      "moo-ab12-cd34@http://192.168.1.50:8787",
    );
    const secure = parseSyncCodeApiHost(
      "moo-ab12-cd34@https://192.168.1.50:8787",
    );

    expect(plain).toEqual({
      kind: "valid",
      endpoint: "http://192.168.1.50:8787",
    });
    expect(secure).toEqual({
      kind: "valid",
      endpoint: "https://192.168.1.50:8787",
    });
    expect(plain).not.toEqual(secure);
  });

  /**
   * Two endpoints on the same host but different paths are different backends.
   * A host-only answer would present them as one.
   */
  it("distinguishes two sub-path endpoints on the same host", () => {
    expect(
      parseSyncCodeApiHost("moo-ab12-cd34@https://shared.example.com/family-a"),
    ).toEqual({
      kind: "valid",
      endpoint: "https://shared.example.com/family-a",
    });
    expect(
      parseSyncCodeApiHost("moo-ab12-cd34@https://shared.example.com/family-b"),
    ).toEqual({
      kind: "valid",
      endpoint: "https://shared.example.com/family-b",
    });
  });

  /**
   * `https://real.example@evil.com` fetches evil.com while reading as
   * real.example. Reporting it as `valid` — with EITHER spelling — would lend
   * the spoof legitimacy, so the only safe answer is "invalid".
   */
  it("never reports a host for a credential-bearing URL", () => {
    const result = parseSyncCodeApiHost(
      "moo-ab12-cd34@https://real.example@evil.com",
    );

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
