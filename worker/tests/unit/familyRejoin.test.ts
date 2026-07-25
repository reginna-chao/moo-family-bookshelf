import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";
import { USER1, USER2, USER3 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId = USER1) {
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
// Existing member rejoin — verification with no method still passes (SEC-1)
// ===========================================================================

describe("POST /:id/join — existing member rejoin (no verification set)", () => {
  it("should allow existing member to rejoin WITHOUT verifySecret when method is none", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins the family initially (no verification set → succeeds)
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(joinRes.status).toBe(200);

    // USER2 rejoins from a second device — no verifySecret provided
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(rejoinRes.status).toBe(200);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.authToken).toBeDefined();
    expect(rejoinJson.data.members).toHaveLength(2);
  });

  it("should not duplicate member on rejoin", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins
    await request("POST", `/api/family/${familyId}/join`, { userId: USER2 });

    // USER2 rejoins
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.members).toHaveLength(2);
    expect(
      rejoinJson.data.members.filter(
        (m: { userId: string }) => m.userId === USER2,
      ),
    ).toHaveLength(1);
  });

  it("should update displayName on rejoin when a new non-empty name is provided", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins with displayName "Bob"
    await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "Bob",
    });

    // USER2 rejoins with a different displayName
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "Bobby",
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    const user2Member = rejoinJson.data.members.find(
      (m: { userId: string }) => m.userId === USER2,
    );
    expect(user2Member.displayName).toBe("Bobby");
  });

  it("should NOT update displayName on rejoin when empty string is provided (auto-recovery default)", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins with displayName "Bob"
    await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      displayName: "Bob",
    });

    // USER2 auto-recovers without providing displayName (defaults to "")
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    const rejoinJson = (await rejoinRes.json()) as Json;
    const user2Member = rejoinJson.data.members.find(
      (m: { userId: string }) => m.userId === USER2,
    );
    // Should keep the original displayName, not overwrite with ""
    expect(user2Member.displayName).toBe("Bob");
  });
});

// ===========================================================================
// SEC-1: existing member rejoin MUST pass the verification gate too
// (verification was hoisted BEFORE the existing-member branch)
// ===========================================================================

describe("POST /:id/join — existing member rejoin verification enforcement (SEC-1)", () => {
  it("should REJECT existing member rejoin with PIN set but no verifySecret (403)", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins the family initially (no verification set yet)
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(joinRes.status).toBe(200);

    // Now USER2 sets up PIN verification
    await seedVerifyRecord(USER2, "pin");

    // USER2 rejoins from a second device — no verifySecret. Since SEC-1, the
    // verification gate runs for existing members too, so this must be rejected.
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(rejoinRes.status).toBe(403);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should REJECT existing member rejoin with pattern set but no verifySecret (403)", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins initially
    await request("POST", `/api/family/${familyId}/join`, { userId: USER2 });

    // Set up pattern verification
    await seedVerifyRecord(USER2, "pattern");

    // Rejoin without secret → rejected under SEC-1
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(rejoinRes.status).toBe(403);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should ALLOW existing member rejoin with a correct PIN verifySecret (200)", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins with no verification, then sets a real PIN via the verify route
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    const joinJson = (await joinRes.json()) as Json;
    const user2Token = joinJson.data.authToken as string;

    // The verify PUT is protected — send with USER2's auth header.
    const verifyRes = await app.request(
      `/api/user/${USER2}/verify`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user2Token}`,
        },
        body: JSON.stringify({ method: "pin", secret: "123456" }),
      },
      { KV: kv, DEV_MODE: "1" },
    );
    expect(verifyRes.status).toBe(200);

    // Rejoin WITH the correct secret → succeeds
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
      verifySecret: "123456",
    });
    expect(rejoinRes.status).toBe(200);
    const rejoinJson = (await rejoinRes.json()) as Json;
    expect(rejoinJson.data.authToken).toBeDefined();
    expect(rejoinJson.data.familyId).toBe(familyId);
  });

  it("should NOT block existing member rejoin by a full family (capacity is new-member-only)", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins → family now full at maxMembers=2
    await request("POST", `/api/family/${familyId}/join`, { userId: USER2 });

    // USER2 rejoins (method none) — must succeed despite the family being full
    const rejoinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(rejoinRes.status).toBe(200);
  });
});

// ===========================================================================
// New member join — verification and capacity still enforced
// ===========================================================================

describe("POST /:id/join — new member verification enforcement", () => {
  it("should allow new member to join without verification when none is set", async () => {
    const { familyId } = await createFamily(USER1);

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(joinRes.status).toBe(200);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.data.members).toHaveLength(2);
  });

  it("should reject new member when verification is required but no secret provided", async () => {
    const { familyId } = await createFamily(USER1);

    // Set up PIN verification for USER2 BEFORE they join
    await seedVerifyRecord(USER2, "pin");

    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER2,
    });
    expect(joinRes.status).toBe(403);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("should still enforce FAMILY_FULL for new members", async () => {
    const { familyId } = await createFamily(USER1);

    // USER2 joins (family now full at maxMembers=2)
    await request("POST", `/api/family/${familyId}/join`, { userId: USER2 });

    // USER3 tries to join → should be rejected
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: USER3,
    });
    expect(joinRes.status).toBe(409);
    const joinJson = (await joinRes.json()) as Json;
    expect(joinJson.error.code).toBe("FAMILY_FULL");
  });
});
