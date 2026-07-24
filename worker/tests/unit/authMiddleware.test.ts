import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { USER1 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, authToken?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(path, { method, headers }, { KV: kv, DEV_MODE: "1" });
}

function requestWithRawAuth(method: string, path: string, authHeader: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };
  return app.request(path, { method, headers }, { KV: kv, DEV_MODE: "1" });
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Auth middleware — token validation branches
// ===========================================================================

describe("Auth middleware token validation", () => {
  it("should return 401 when Authorization header has invalid format (not Bearer)", async () => {
    const res = await requestWithRawAuth(
      "GET",
      `/api/user/${USER1}/books`,
      "Basic sometoken",
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toBe("Invalid or expired token");
  });

  it("should return 401 when token is not a 64-char hex string", async () => {
    const res = await requestWithRawAuth(
      "GET",
      `/api/user/${USER1}/books`,
      "Bearer short-token",
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toBe("Invalid or expired token");
  });

  it("should return 401 when token is valid format but not found in KV", async () => {
    const fakeToken = "a".repeat(64);
    const res = await request("GET", `/api/user/${USER1}/books`, fakeToken);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toBe("Invalid or expired token");
  });

  it("should return 401 when token contains uppercase hex characters", async () => {
    const upperToken = "A".repeat(64);
    const res = await request("GET", `/api/user/${USER1}/books`, upperToken);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 401 when Authorization header is missing on protected route", async () => {
    const res = await request("GET", `/api/user/${USER1}/books`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toBe("Authorization header required");
  });
});
