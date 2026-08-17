import { describe, it, expect, vi, afterEach } from "vitest";

describe("DEFAULT_API_ENDPOINT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to prod URL when VITE_PWA_API_ENDPOINT is empty string", async () => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", "");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe(
      "https://moo-family-bookshelf.rcwork.workers.dev",
    );
  });

  it("falls back to prod URL when VITE_PWA_API_ENDPOINT is not set", async () => {
    // Do not stub — rely on key being absent from test environment
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe(
      "https://moo-family-bookshelf.rcwork.workers.dev",
    );
  });

  it("uses VITE_PWA_API_ENDPOINT when set to a valid URL", async () => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", "https://custom.workers.dev");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://custom.workers.dev");
  });

  /**
   * `VersionWarning` compares this constant directly against
   * `ApiClient.getEndpoint()`, which holds what `validateEndpointUrl` returns.
   * An env value in any other spelling would make the official default read as
   * a self-hosted endpoint and warn about nothing.
   */
  it.each([
    ["a trailing slash", "https://custom.workers.dev/"],
    ["repeated trailing slashes", "https://custom.workers.dev///"],
    ["an upper-case host", "https://CUSTOM.Workers.DEV"],
    ["an explicit default port", "https://custom.workers.dev:443"],
  ])("canonicalizes an env value with %s", async (_label, raw) => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", raw);
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://custom.workers.dev");
  });

  it("keeps a sub-path endpoint's path", async () => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", "https://host.example/moo/");
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
    ["a bare host with no scheme", "custom.workers.dev"],
  ])("throws at module load for %s", async (_label, raw) => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", raw);
    await expect(import("@/constants")).rejects.toThrow();
  });
});
