import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

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
  return app.request(path, init, { KV: kv });
}

function rawRequest(method: string, path: string, rawBody: string, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv },
  );
}

async function createFamily(userId = "user1") {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function createFamilyWithTwoMembers() {
  const { familyId, authToken: token1 } = await createFamily("user1");
  const joinRes = await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });
  const joinJson = (await joinRes.json()) as Json;
  const token2 = joinJson.data.authToken as string;
  return { familyId, token1, token2 };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// PUT /api/family/:id/transfer — uncovered branches
// ===========================================================================

describe("PUT /api/family/:id/transfer edge cases", () => {
  it("should return 400 INVALID_JSON for malformed request body", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await rawRequest(
      "PUT",
      `/api/family/${familyId}/transfer`,
      "{not valid json}",
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 INVALID_USER_ID for invalid newOwnerId format", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: "user<script>" },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 400 INVALID_FAMILY_ID for invalid family ID format", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      "/api/family/INVALID/transfer",
      { newOwnerId: "user2" },
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 401 UNAUTHORIZED without auth token", async () => {
    const { familyId } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: "user2" },
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// DELETE /api/family/:id/member/:uid — additional uncovered branches
// ===========================================================================

describe("DELETE /api/family/:id/member/:uid edge cases", () => {
  it("should return 400 INVALID_FAMILY_ID for invalid family ID on delete", async () => {
    const { token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      "/api/family/INVALID/member/user2",
      undefined,
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 400 INVALID_USER_ID for invalid target userId on delete", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user<script>`,
      undefined,
      token1,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });

  it("should return 404 FAMILY_NOT_FOUND when family record is missing", async () => {
    const { familyId, token1 } = await createFamilyWithTwoMembers();

    // Delete the family record from KV
    await kv.delete(`family:${familyId}`);

    const res = await request(
      "DELETE",
      `/api/family/${familyId}/member/user2`,
      undefined,
      token1,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });
});

// ===========================================================================
// POST /api/family/:id/join — additional uncovered branches
// ===========================================================================

describe("POST /api/family/:id/join edge cases", () => {
  it("should return 400 INVALID_FAMILY_ID for invalid family ID on join", async () => {
    const res = await request("POST", "/api/family/INVALID/join", { userId: "user1" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 400 INVALID_JSON for malformed JSON on join", async () => {
    const res = await rawRequest("POST", "/api/family/abcd-1234/join", "{bad json}");
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 400 MISSING_USER_ID when userId is missing on join", async () => {
    const { familyId } = await createFamily("user1");
    const res = await request("POST", `/api/family/${familyId}/join`, {});
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_USER_ID");
  });

  it("should return 400 INVALID_USER_ID for invalid userId on join", async () => {
    const { familyId } = await createFamily("user1");
    const res = await request("POST", `/api/family/${familyId}/join`, { userId: "user<script>" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });
});

// ===========================================================================
// GET /api/family/:id/members — additional uncovered branches
// ===========================================================================

describe("GET /api/family/:id/members edge cases", () => {
  it("should return 400 INVALID_FAMILY_ID for invalid family ID", async () => {
    const { authToken } = await createFamily("user1");

    const res = await request("GET", "/api/family/INVALID/members", undefined, authToken);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 403 FORBIDDEN when user is not a member of the family", async () => {
    const { authToken } = await createFamily("user1");

    // user1 is a member of their own family, not abcd-1234
    const res = await request("GET", "/api/family/abcd-1234/members", undefined, authToken);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("should return 404 FAMILY_NOT_FOUND when family record is deleted", async () => {
    const { familyId, authToken } = await createFamily("user1");

    // Delete the family record from KV but keep the member mapping
    await kv.delete(`family:${familyId}`);

    const res = await request("GET", `/api/family/${familyId}/members`, undefined, authToken);
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });
});

// ===========================================================================
// PUT /api/family/:id/member/:uid/displayName — additional uncovered branches
// ===========================================================================

describe("PUT /api/family/:id/member/:uid/displayName edge cases", () => {
  it("should return 400 INVALID_USER_ID for invalid target userId", async () => {
    const { familyId, authToken } = await createFamily("user1");

    const res = await request(
      "PUT",
      `/api/family/${familyId}/member/user<script>/displayName`,
      { displayName: "Test" },
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_USER_ID");
  });
});

// ===========================================================================
// Index — 404 fallback and error handler
// ===========================================================================

describe("Index fallback routes", () => {
  it("should return 404 for unknown routes", async () => {
    const res = await app.request("/nonexistent", { method: "GET" }, { KV: kv });
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FOUND");
  });

  it("should return health check response on root", async () => {
    const res = await app.request("/", { method: "GET" }, { KV: kv });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.status).toBe("ok");
  });

  it("should return 500 INTERNAL_ERROR when an unhandled error occurs", async () => {
    // Create a KV that throws on get to trigger an unhandled error in route handler
    const brokenKv = {
      get: async () => { throw new Error("KV unavailable"); },
      put: async () => { throw new Error("KV unavailable"); },
      delete: async () => { throw new Error("KV unavailable"); },
      list: async () => { throw new Error("KV unavailable"); },
      getWithMetadata: async () => { throw new Error("KV unavailable"); },
    } as unknown as KVNamespace;

    // POST /api/family is a public route (no auth needed), triggers KV.put which will throw
    const res = await app.request(
      "/api/family",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "user1" }),
      },
      { KV: brokenKv },
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INTERNAL_ERROR");
  });
});
