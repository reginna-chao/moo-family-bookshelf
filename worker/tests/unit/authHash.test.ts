import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";

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

/** Helper: hash an email to get its userId via the /api/auth/hash endpoint. */
async function hashEmail(email: string): Promise<string> {
  const res = await request("POST", "/api/auth/hash", {
    body: JSON.stringify({ email }),
  });
  const json = (await res.json()) as Json;
  return json.data.userId as string;
}

/** Helper: create a family for a given userId, returns familyId + authToken. */
async function createFamily(userId: string): Promise<{ familyId: string; authToken: string }> {
  const res = await app.request(
    "/api/family",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    },
    { KV: kv },
  );
  const json = (await res.json()) as Json;
  return { familyId: json.data.familyId as string, authToken: json.data.authToken as string };
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

  it("should return existingFamilyId null and memberCount 0 when user has no family", async () => {
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "nofamily@example.com" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBeNull();
    expect(json.data.memberCount).toBe(0);
  });

  it("should return correct existingFamilyId and memberCount when user has a family", async () => {
    // First, hash email to get userId
    const userId = await hashEmail("familyuser@example.com");

    // Create a family for this user
    const { familyId } = await createFamily(userId);

    // Now hash again — should include family info
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "familyuser@example.com" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBe(familyId);
    expect(json.data.memberCount).toBe(1);
  });

  it("should return correct memberCount when family has multiple members", async () => {
    const userId1 = await hashEmail("owner@example.com");
    const userId2 = await hashEmail("member@example.com");

    // Create family with user1
    const { familyId } = await createFamily(userId1);

    // user2 joins
    await app.request(
      `/api/family/${familyId}/join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: userId2 }),
      },
      { KV: kv },
    );

    // Hash owner — should show memberCount 2
    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "owner@example.com" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBe(familyId);
    expect(json.data.memberCount).toBe(2);
  });

  it("should return existingFamilyId with memberCount 0 when family record is missing", async () => {
    const userId = await hashEmail("orphan@example.com");

    // Manually set member key without a family record (orphaned state)
    await kv.put(kvKeys.member(userId), "abcd-1234");

    const res = await request("POST", "/api/auth/hash", {
      body: JSON.stringify({ email: "orphan@example.com" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBe("abcd-1234");
    expect(json.data.memberCount).toBe(0);
  });
});
