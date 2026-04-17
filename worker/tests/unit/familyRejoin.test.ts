import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId = "user1") {
  const res = await request("POST", "/api/family", { userId });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function seedVerifyRecord(userId: string, method: "pin" | "pattern") {
  // Seed a verification record so the user "has verification set"
  const record: VerifyRecord = {
    method,
    hash: "fakehash1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    salt: "fakesalt1234567890abcdef12345678",
    prompted: 1,
    failCount: 0,
    lockedUntil: null,
  };
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// Existing member rejoin — skip verification
// ===========================================================================

describe("POST /:id/join — existing member rejoin skips verification", () => {
  it("should allow existing member to rejoin WITHOUT verifySecret", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins the family initially (no verification set → succeeds)
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(joinRes.status).toBe(200);

    // user2 rejoins from a second device — no verifySecret provided
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(rejoinRes.status).toBe(200);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.authToken).toBeDefined();
    expect(rejoinJson.data.members).toHaveLength(2);
  });

  it("should allow existing member to rejoin when they have PIN verification set but no secret provided", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins the family initially (no verification set yet)
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(joinRes.status).toBe(200);

    // Now user2 sets up PIN verification
    await seedVerifyRecord("user2", "pin");

    // user2 rejoins from a second device — no verifySecret, but has PIN set
    // Should still succeed because they are an existing member
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(rejoinRes.status).toBe(200);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.authToken).toBeDefined();
    expect(rejoinJson.data.familyId).toBe(familyId);
  });

  it("should allow existing member to rejoin when they have pattern verification set but no secret provided", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins initially
    await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });

    // Set up pattern verification
    await seedVerifyRecord("user2", "pattern");

    // Rejoin without secret → should succeed
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(rejoinRes.status).toBe(200);
  });

  it("should not duplicate member on rejoin", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins
    await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });

    // user2 rejoins
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.members).toHaveLength(2);
    expect(rejoinJson.data.members.filter((m: { userId: string }) => m.userId === "user2")).toHaveLength(1);
  });

  it("should update displayName on rejoin when a new non-empty name is provided", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins with displayName "Bob"
    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      displayName: "Bob",
    });

    // user2 rejoins with a different displayName
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      displayName: "Bobby",
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    const user2Member = rejoinJson.data.members.find((m: { userId: string }) => m.userId === "user2");
    expect(user2Member.displayName).toBe("Bobby");
  });

  it("should NOT update displayName on rejoin when empty string is provided (auto-recovery default)", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins with displayName "Bob"
    await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      displayName: "Bob",
    });

    // user2 auto-recovers without providing displayName (defaults to "")
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    const user2Member = rejoinJson.data.members.find((m: { userId: string }) => m.userId === "user2");
    // Should keep the original displayName, not overwrite with ""
    expect(user2Member.displayName).toBe("Bob");
  });
});

// ===========================================================================
// New member join — verification still enforced
// ===========================================================================

describe("POST /:id/join — new member verification enforcement", () => {
  it("should allow new member to join without verification when none is set", async () => {
    const { familyId } = await createFamily("user1");

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.data.members).toHaveLength(2);
  });

  it("should reject new member when verification is required but no secret provided", async () => {
    const { familyId } = await createFamily("user1");

    // Set up PIN verification for user2 BEFORE they join
    await seedVerifyRecord("user2", "pin");

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(joinRes.status).toBe(403);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should still enforce FAMILY_FULL for new members", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins (family now full at maxMembers=2)
    await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });

    // user3 tries to join → should be rejected
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user3",
    });
    expect(joinRes.status).toBe(409);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.error.code).toBe("FAMILY_FULL");
  });

  it("should NOT enforce FAMILY_FULL for existing member rejoin", async () => {
    const { familyId } = await createFamily("user1");

    // user2 joins (family now full)
    await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });

    // user2 rejoins — should succeed even though family is "full"
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(rejoinRes.status).toBe(200);
  });
});
