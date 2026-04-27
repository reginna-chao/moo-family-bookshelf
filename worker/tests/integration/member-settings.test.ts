import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BoolFlag } from "../../src/kv/schema";

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

async function createFamilyAndGetToken(userId: string, displayName = "") {
  const res = await request("POST", "/api/family", { userId, displayName });
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function joinFamilyAndGetToken(familyId: string, userId: string, displayName = "") {
  const res = await request("POST", `/api/family/${familyId}/join`, { userId, displayName });
  const json = (await res.json()) as Json;
  return { authToken: json.data.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

// ===========================================================================
// PATCH /api/family/:id/member/:uid — member settings (canLend, readmooName)
// ===========================================================================

describe("PATCH /api/family/:id/member/:uid", () => {
  it("allows owner to update another member's canLend", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { canLend: BoolFlag.FALSE },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.userId).toBe("bob");
    expect(json.data.canLend).toBe(BoolFlag.FALSE);
  });

  it("allows owner to update another member's readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { readmooName: "BobReadmoo" },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("BobReadmoo");
  });

  it("allows a non-owner member to update their own readmooName", async () => {
    const { familyId } = await createFamilyAndGetToken("alice", "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { readmooName: "BobsName" },
      bobToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("BobsName");
  });

  it("rejects non-owner trying to update another member's canLend with 403", async () => {
    const { familyId } = await createFamilyAndGetToken("alice", "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/alice`,
      { canLend: BoolFlag.FALSE },
      bobToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("rejects member trying to update their OWN canLend with 403 (only owner can)", async () => {
    const { familyId } = await createFamilyAndGetToken("alice", "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { canLend: BoolFlag.FALSE },
      bobToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("allows owner to update their own readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/alice`,
      { readmooName: "AliceReadmoo" },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("AliceReadmoo");
  });

  it("rejects invalid canLend values (must be 0 or 1)", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    // Numeric out of range
    const resNum = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { canLend: 2 },
      ownerToken,
    );
    expect(resNum.status).toBe(400);
    expect(((await resNum.json()) as Json).error.code).toBe("INVALID_FIELDS");

    // String value
    const resStr = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { canLend: "yes" },
      ownerToken,
    );
    expect(resStr.status).toBe(400);
    expect(((await resStr.json()) as Json).error.code).toBe("INVALID_FIELDS");
  });

  it("rejects readmooName exceeding 50 characters", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { readmooName: "a".repeat(51) },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("rejects empty-string readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");
    await joinFamilyAndGetToken(familyId, "bob", "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/bob`,
      { readmooName: "" },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("returns 404 when family does not exist", async () => {
    // Need a valid token to pass auth middleware
    const { authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");

    const res = await request(
      "PATCH",
      "/api/family/aaaa-zzzz/member/alice",
      { readmooName: "Whatever" },
      ownerToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("returns 404 when target member is not in the family", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken("alice", "Alice");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/ghost`,
      { readmooName: "Boo" },
      ownerToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 401 when no auth token is provided", async () => {
    const { familyId } = await createFamilyAndGetToken("alice", "Alice");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/alice`,
      { readmooName: "Foo" },
    );
    expect(res.status).toBe(401);
  });
});
