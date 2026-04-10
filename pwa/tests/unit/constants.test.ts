import { describe, it, expect, vi, afterEach } from "vitest";

describe("DEFAULT_API_ENDPOINT", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to prod URL when VITE_PWA_API_ENDPOINT is empty string", async () => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", "");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://moo-family-bookshelf.rcwork.workers.dev");
  });

  it("falls back to prod URL when VITE_PWA_API_ENDPOINT is not set", async () => {
    // Do not stub — rely on key being absent from test environment
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://moo-family-bookshelf.rcwork.workers.dev");
  });

  it("uses VITE_PWA_API_ENDPOINT when set to a valid URL", async () => {
    vi.stubEnv("VITE_PWA_API_ENDPOINT", "https://custom.workers.dev");
    const { DEFAULT_API_ENDPOINT } = await import("@/constants");
    expect(DEFAULT_API_ENDPOINT).toBe("https://custom.workers.dev");
  });
});
