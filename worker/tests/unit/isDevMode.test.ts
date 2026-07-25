import { describe, it, expect } from "vitest";
import { isDevMode, type Env } from "../../src/utils/env";

function makeEnv(overrides: Partial<Env> & Record<string, unknown> = {}): Env {
  return { KV: {} as KVNamespace, ...overrides };
}

describe("isDevMode", () => {
  it("returns false when DEV_MODE is not set", () => {
    expect(isDevMode(makeEnv())).toBe(false);
  });

  it("returns false when DEV_MODE is not '1'", () => {
    expect(isDevMode(makeEnv({ DEV_MODE: "0" }))).toBe(false);
    expect(isDevMode(makeEnv({ DEV_MODE: "true" }))).toBe(false);
    expect(isDevMode(makeEnv({ DEV_MODE: "" }))).toBe(false);
  });

  it("returns true when DEV_MODE=1 and CF_WORKER is undefined (local dev)", () => {
    expect(isDevMode(makeEnv({ DEV_MODE: "1" }))).toBe(true);
  });

  it("returns false when DEV_MODE=1 but CF_WORKER matches a production name", () => {
    expect(
      isDevMode(makeEnv({ DEV_MODE: "1", CF_WORKER: "moo-family-bookshelf" })),
    ).toBe(false);
  });

  it("returns true when DEV_MODE=1 and CF_WORKER is a non-production name", () => {
    expect(
      isDevMode(
        makeEnv({ DEV_MODE: "1", CF_WORKER: "moo-family-bookshelf-dev" }),
      ),
    ).toBe(true);
    expect(
      isDevMode(makeEnv({ DEV_MODE: "1", CF_WORKER: "my-custom-worker" })),
    ).toBe(true);
  });
});
