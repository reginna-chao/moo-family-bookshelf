import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const VALID_FP = "a".repeat(64);

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

async function createFamily(userId: string): Promise<{ familyId: string; authToken: string }> {
  const res = await request("POST", "/api/family", { userId, keyFingerprint: VALID_FP });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return { familyId: json.data.familyId as string, authToken: json.data.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/family — duplicate prevention", () => {
  it("should create family normally when user has no existing family", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.familyId).toBeDefined();
    expect(json.data.members).toHaveLength(1);
    expect(json.data.members[0].userId).toBe("user1");
  });

  it("should return 409 when solo member tries to create another family", async () => {
    // Create first family (user1 is sole member and owner)
    const { familyId: oldFamilyId } = await createFamily("user1");

    // Verify old family exists
    expect(await kv.get(kvKeys.family(oldFamilyId))).not.toBeNull();
    expect(await kv.get(kvKeys.member("user1"))).toBe(oldFamilyId);

    // Try to create a second family — should be blocked (user should rejoin instead)
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("ALREADY_IN_FAMILY");

    // Old family should still exist
    expect(await kv.get(kvKeys.family(oldFamilyId))).not.toBeNull();
    expect(await kv.get(kvKeys.member("user1"))).toBe(oldFamilyId);
  });

  it("should return 409 ALREADY_IN_FAMILY when user has family with other members", async () => {
    // Create family with two members
    const { familyId } = await createFamily("user1");
    const joinRes = await request("POST", `/api/family/${familyId}/join`, { userId: "user2", keyFingerprint: VALID_FP });
    expect(joinRes.status).toBe(200);

    // user1 tries to create a new family — should be blocked
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("ALREADY_IN_FAMILY");
    expect(json.error.message).toBe("已有家庭群組，無法再建立新的");

    // Original family should still exist
    expect(await kv.get(kvKeys.family(familyId))).not.toBeNull();
    expect(await kv.get(kvKeys.member("user1"))).toBe(familyId);
  });

  it("should return 409 when non-owner user has family with other members", async () => {
    // Create family with user1 as owner, user2 joins
    const { familyId } = await createFamily("user1");
    await request("POST", `/api/family/${familyId}/join`, { userId: "user2" });

    // user2 (non-owner) tries to create a new family — should be blocked
    const res = await request("POST", "/api/family", { userId: "user2", keyFingerprint: VALID_FP });
    expect(res.status).toBe(409);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("ALREADY_IN_FAMILY");
  });

  it("should proceed when member key exists but family record is missing (orphaned)", async () => {
    // Simulate orphaned member key (family record was deleted but member key remains)
    await kv.put(kvKeys.member("user1"), "abcd-1234");

    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.familyId).toBeDefined();
    expect(json.data.members).toHaveLength(1);
  });
});
