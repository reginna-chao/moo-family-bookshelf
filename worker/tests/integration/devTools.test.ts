import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

beforeEach(() => {
  kv = createMockKV();
});

function devEnv(overrides: Record<string, unknown> = {}) {
  return { KV: kv, DEV_MODE: "1", ...overrides };
}

function prodEnv(overrides: Record<string, unknown> = {}) {
  return { KV: kv, ...overrides };
}

describe("GET /api/_openapi.json", () => {
  it("returns OpenAPI 3.1 spec in dev mode (local wrangler dev)", async () => {
    const res = await app.request(
      "/api/_openapi.json",
      { method: "GET" },
      devEnv(),
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.openapi).toBe("3.1.0");
    expect(json.info.title).toBe("MooFamily Bookshelf API");
    expect(json.info.version).toBeDefined();
    expect(json.paths).toBeDefined();
  });

  it("includes known route paths in the spec", async () => {
    const res = await app.request(
      "/api/_openapi.json",
      { method: "GET" },
      devEnv(),
    );
    const json = (await res.json()) as Json;
    const paths = Object.keys(json.paths ?? {});
    expect(paths.length).toBeGreaterThan(0);
  });

  it("returns 404 when DEV_MODE is not set (production)", async () => {
    const res = await app.request(
      "/api/_openapi.json",
      { method: "GET" },
      prodEnv(),
    );
    expect(res.status).toBe(404);

    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.message).toBe("Route not found");
  });

  it("returns 404 when CF_WORKER is production name even with DEV_MODE=1", async () => {
    const res = await app.request(
      "/api/_openapi.json",
      { method: "GET" },
      devEnv({ CF_WORKER: "moo-family-bookshelf" }),
    );
    expect(res.status).toBe(404);

    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("returns 200 when CF_WORKER is a non-production dev worker name", async () => {
    const res = await app.request(
      "/api/_openapi.json",
      { method: "GET" },
      devEnv({ CF_WORKER: "moo-family-bookshelf-dev" }),
    );
    expect(res.status).toBe(200);

    const json = (await res.json()) as Json;
    expect(json.openapi).toBe("3.1.0");
  });
});

describe("GET /api/_docs", () => {
  it("returns Swagger UI HTML in dev mode", async () => {
    const res = await app.request("/api/_docs", { method: "GET" }, devEnv());
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body.toLowerCase()).toContain("swagger");
  });

  it("returns 404 when DEV_MODE is not set (production)", async () => {
    const res = await app.request("/api/_docs", { method: "GET" }, prodEnv());
    expect(res.status).toBe(404);

    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.message).toBe("Route not found");
  });

  it("returns 404 when CF_WORKER is production name even with DEV_MODE=1", async () => {
    const res = await app.request(
      "/api/_docs",
      { method: "GET" },
      devEnv({ CF_WORKER: "moo-family-bookshelf" }),
    );
    expect(res.status).toBe(404);

    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
