import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPwaUrl } from "@/constants";

describe("DEFAULT_API_ENDPOINT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to dev worker URL when VITE_EXTENSION_API_ENDPOINT is empty string", async () => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", "");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe(
      "https://moo-family-bookshelf-dev.rcwork.workers.dev",
    );
  });

  it("uses VITE_EXTENSION_API_ENDPOINT when set to a valid URL", async () => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", "https://custom-api.workers.dev");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://custom-api.workers.dev");
  });

  /**
   * The constant is compared directly against `ApiClient.getEndpoint()` (the
   * family endpoint-switch gate, the sync code's `@host` decision). The client
   * stores what `validateEndpointUrl` returns, so an env value in any other
   * spelling would make "already on the default endpoint" read as a pending
   * switch — and prompt the user to confirm a move to where they already are.
   */
  it.each([
    ["a trailing slash", "https://custom-api.workers.dev/"],
    ["repeated trailing slashes", "https://custom-api.workers.dev///"],
    ["an upper-case host", "https://CUSTOM-API.Workers.DEV"],
    ["an explicit default port", "https://custom-api.workers.dev:443"],
  ])("canonicalizes an env value with %s", async (_label, raw) => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", raw);
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://custom-api.workers.dev");
  });

  it("keeps a sub-path endpoint's path", async () => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", "https://host.example/moo/");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://host.example/moo");
  });

  /**
   * A misconfigured build is dead either way — `new ApiClient()` already threw
   * on such a value. Failing at the definition names the culprit instead of
   * surfacing as a mystery error deep inside the first request.
   */
  it.each([
    ["plain HTTP on a public host", "http://evil.example.com"],
    ["embedded credentials", "https://real.example@evil.com"],
    ["a non-HTTP scheme", "ftp://files.example.com"],
    ["a bare host with no scheme", "custom-api.workers.dev"],
  ])("throws at module load for %s", async (_label, raw) => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", raw);
    await expect(import("@/constants")).rejects.toThrow();
  });
});

describe("DEFAULT_PWA_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to dev pages URL when VITE_EXTENSION_PWA_URL is empty string", async () => {
    vi.stubEnv("VITE_EXTENSION_PWA_URL", "");
    const { DEFAULT_PWA_URL } = await import("@/constants");
    expect(DEFAULT_PWA_URL).toBe("https://moo-family-bookshelf-dev.pages.dev");
  });

  it("uses VITE_EXTENSION_PWA_URL when set to a valid URL", async () => {
    vi.stubEnv("VITE_EXTENSION_PWA_URL", "https://custom.pages.dev");
    const { DEFAULT_PWA_URL } = await import("@/constants");
    expect(DEFAULT_PWA_URL).toBe("https://custom.pages.dev");
  });

  it("DEFAULT_API_ENDPOINT and DEFAULT_PWA_URL are independent when both set", async () => {
    vi.stubEnv("VITE_EXTENSION_API_ENDPOINT", "https://api.custom.dev");
    vi.stubEnv("VITE_EXTENSION_PWA_URL", "https://pwa.custom.dev");
    const { DEFAULT_API_ENDPOINT, DEFAULT_PWA_URL } =
      await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://api.custom.dev");
    expect(DEFAULT_PWA_URL).toBe("https://pwa.custom.dev");
  });
});

describe("buildPwaUrl", () => {
  it("builds URL without qrToken when not provided", () => {
    const url = buildPwaUrl("moo-abc123", "user456");
    expect(url).toContain("#code=moo-abc123&uid=user456");
    expect(url).not.toContain("qrt=");
  });

  it("builds URL with qrToken when provided", () => {
    const url = buildPwaUrl("moo-abc123", "user456", "token-xyz");
    expect(url).toContain("#code=moo-abc123&uid=user456&qrt=token-xyz");
  });

  it("builds URL without qrToken when qrToken is undefined", () => {
    const url = buildPwaUrl("moo-abc123", "user456", undefined);
    expect(url).not.toContain("qrt=");
  });

  it("builds URL without qrToken when qrToken is empty string", () => {
    const url = buildPwaUrl("moo-abc123", "user456", "");
    expect(url).not.toContain("qrt=");
  });

  it("encodes special characters in qrToken", () => {
    const url = buildPwaUrl(
      "moo-abc123",
      "user456",
      "token/with+special=chars",
    );
    expect(url).toContain("qrt=token%2Fwith%2Bspecial%3Dchars");
  });

  it("encodes special characters in syncCode and userId", () => {
    const url = buildPwaUrl("moo-abc@host.com", "user&id");
    expect(url).toContain("code=moo-abc%40host.com");
    expect(url).toContain("uid=user%26id");
  });
});
