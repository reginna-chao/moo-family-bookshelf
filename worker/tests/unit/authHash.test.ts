import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  opts?: {
    body?: string;
    headers?: Record<string, string>;
  },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts?.headers,
  };
  const init: RequestInit = { method, headers };
  if (opts?.body) init.body = opts.body;
  return app.request(path, init, { KV: kv });
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/auth/hash", () => {
  it("should return userId for a valid email", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "test@example.com" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.userId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should produce the same userId for different casing", async () => {
    const res1 = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "Test@Example.COM" }),
    });
    const res2 = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "test@example.com" }),
    });
    const json1 = (await res1.json()) as Json;
    const json2 = (await res2.json()) as Json;
    expect(json1.data.userId).toBe(json2.data.userId);
  });

  it("should produce the same userId when email has extra whitespace", async () => {
    const res1 = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "  test@example.com  " }),
    });
    const res2 = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "test@example.com" }),
    });
    const json1 = (await res1.json()) as Json;
    const json2 = (await res2.json()) as Json;
    expect(json1.data.userId).toBe(json2.data.userId);
  });

  it("should return 400 when email is missing", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_EMAIL");
  });

  it("should return 400 when email is empty string", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_EMAIL");
  });

  it("should return 400 when email is whitespace only", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "   " }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_EMAIL");
  });

  it("should return 400 for invalid JSON body", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: "not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should not require authentication", async () => {
    // No Authorization header — should still succeed
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "test@example.com" }),
    });
    expect(res.status).toBe(200);
  });
});
