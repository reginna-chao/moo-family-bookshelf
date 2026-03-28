import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const VALID_USER_ID = "a".repeat(64); // 64-char hex
const VALID_FAMILY_ID = "abcd-1234";

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

/** Seed KV with a member mapping and optionally an old auth token. */
async function seedMember(
  userId: string,
  familyId: string,
  oldToken?: string,
) {
  await kv.put(`member:${userId}`, familyId);
  if (oldToken) {
    await kv.put(
      `auth:${userId}`,
      JSON.stringify({ token: oldToken, createdAt: "2026-01-01T00:00:00Z" }),
    );
    await kv.put(`token:${oldToken}`, userId);
  }
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/auth/refresh", () => {
  it("should return a new token for valid userId and familyId", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should not require Authorization header", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    // No Authorization header — should still succeed
    expect(res.status).toBe(200);
  });

  it("should delete old token entry after refresh", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    const newToken = json.data.token;

    // Old token should be removed from KV
    const oldTokenLookup = await kv.get(`token:${oldToken}`);
    expect(oldTokenLookup).toBeNull();

    // New token should exist in KV
    const newTokenLookup = await kv.get(`token:${newToken}`);
    expect(newTokenLookup).toBe(VALID_USER_ID);

    // auth:{userId} should point to new token
    const authRecord = await kv.get(`auth:${VALID_USER_ID}`, "json") as Json;
    expect(authRecord.token).toBe(newToken);
  });

  it("should return 400 for invalid userId format (too short)", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "abc123", familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid userId format (uppercase hex)", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "A".repeat(64), familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing userId", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing familyId", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for empty familyId", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: "" }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid JSON body", async () => {
    const res = await request("POST", "/api/auth/refresh", {
      body: "not json",
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 403 when userId is not a member of any family", async () => {
    // No member entry seeded
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should return 403 when userId belongs to a different family", async () => {
    await seedMember(VALID_USER_ID, "wxyz-9876"); // different family

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("NOT_FAMILY_MEMBER");
  });

  it("should work when there is no existing auth token", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID); // no old token

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("should return different tokens on consecutive refreshes", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);

    const res1 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });
    const json1 = (await res1.json()) as Json;

    const res2 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: VALID_FAMILY_ID }),
    });
    const json2 = (await res2.json()) as Json;

    expect(json1.data.token).not.toBe(json2.data.token);
  });
});
