import { describe, it, expect, vi, afterEach } from "vitest";
import { getAppEnv } from "@/utils/appEnv";

describe("getAppEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "local" when MODE is "development"', () => {
    vi.stubEnv("MODE", "development");
    expect(getAppEnv()).toBe("local");
  });

  it('returns "dev" when MODE is "remote"', () => {
    vi.stubEnv("MODE", "remote");
    expect(getAppEnv()).toBe("dev");
  });

  it('returns "prod" when MODE is "production"', () => {
    vi.stubEnv("MODE", "production");
    expect(getAppEnv()).toBe("prod");
  });

  it('returns "prod" for unknown MODE', () => {
    vi.stubEnv("MODE", "unknown");
    expect(getAppEnv()).toBe("prod");
  });
});
