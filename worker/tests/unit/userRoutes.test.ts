import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

function rawRequest(method: string, path: string, rawBody: string, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv, DEV_MODE: "1" },
  );
}

async function createFamilyAndGetToken(userId = "user1") {
  const res = await request("POST", "/api/family", { userId, keyFingerprint: "a".repeat(64) });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// GET /api/user/:id/books — validation and authorization
// ===========================================================================

describe("GET /api/user/:id/books", () => {
  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("GET", "/api/user/user1/books");
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("GET", "/api/user/user<script>/books", undefined, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when accessing another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("GET", "/api/user/user2/books", undefined, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return data when user has books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    // Save books first
    await request("PUT", "/api/user/user1/books", { payload: "encrypted" }, authToken);

    // Then retrieve
    const res = await request("GET", "/api/user/user1/books", undefined, authToken);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.payload).toBe("encrypted");
    expect(json.data.lastUpdated).toBeDefined();
  });
});

// ===========================================================================
// PUT /api/user/:id/books — validation and authorization
// ===========================================================================

describe("PUT /api/user/:id/books", () => {
  it("should return 401 UNAUTHORIZED when no auth token is provided", async () => {
    const res = await request("PUT", "/api/user/user1/books", { payload: "data" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_USER_ID for invalid userId on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user<script>/books", { payload: "data" }, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 403 FORBIDDEN when modifying another user's books", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user2/books", { payload: "data" }, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 INVALID_JSON for malformed request body on PUT", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await rawRequest("PUT", "/api/user/user1/books", "{not valid}", authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_PAYLOAD when payload is not a string", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user1/books", { payload: 123 }, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });

  it("should return 400 INVALID_PAYLOAD when payload is missing", async () => {
    const { authToken } = await createFamilyAndGetToken("user1");

    const res = await request("PUT", "/api/user/user1/books", {}, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_PAYLOAD");
  });
});
