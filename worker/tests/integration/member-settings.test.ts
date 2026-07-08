import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { BoolFlag, kvKeys, type RawFamilyRecord } from "../../src/kv/schema";
import { ALICE, BOB, NOBODY } from "../helpers/ids";

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
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { canLend: BoolFlag.FALSE },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.userId).toBe(BOB);
    expect(json.data.canLend).toBe(BoolFlag.FALSE);
  });

  it("allows owner to update another member's readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "BobReadmoo" },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("BobReadmoo");
  });

  it("allows a non-owner member to update their own readmooName", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "BobsName" },
      bobToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("BobsName");
  });

  it("rejects non-owner trying to update another member's canLend with 403", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${ALICE}`,
      { canLend: BoolFlag.FALSE },
      bobToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("rejects member trying to update their OWN canLend with 403 (only owner can)", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { canLend: BoolFlag.FALSE },
      bobToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("allows owner to update their own readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${ALICE}`,
      { readmooName: "AliceReadmoo" },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.readmooName).toBe("AliceReadmoo");
  });

  it("rejects invalid canLend values (must be 0 or 1)", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // Numeric out of range
    const resNum = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { canLend: 2 },
      ownerToken,
    );
    expect(resNum.status).toBe(400);
    expect(((await resNum.json()) as Json).error.code).toBe("INVALID_FIELDS");

    // String value
    const resStr = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { canLend: "yes" },
      ownerToken,
    );
    expect(resStr.status).toBe(400);
    expect(((await resStr.json()) as Json).error.code).toBe("INVALID_FIELDS");
  });

  it("rejects readmooName exceeding 50 characters", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "a".repeat(51) },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("rejects empty-string readmooName", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "" },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("returns 404 when family does not exist", async () => {
    // Need a valid token to pass auth middleware
    const { authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");

    const res = await request(
      "PATCH",
      `/api/family/aaaa-zzzz/member/${ALICE}`,
      { readmooName: "Whatever" },
      ownerToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("returns 404 when target member is not in the family", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${NOBODY}`,
      { readmooName: "Boo" },
      ownerToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MEMBER_NOT_FOUND");
  });

  it("returns 401 when no auth token is provided", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${ALICE}`,
      { readmooName: "Foo" },
    );
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // Wave J — readmooName: null semantic (delete the field)
  // ---------------------------------------------------------------------------

  it("readmooName: null removes the field from the stored member record", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // First set a value so there is something to clear
    const setRes = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "BobReadmoo" },
      ownerToken,
    );
    expect(setRes.status).toBe(200);

    // Then clear it with null
    const clearRes = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: null },
      ownerToken,
    );
    expect(clearRes.status).toBe(200);
    const clearJson = (await clearRes.json()) as Json;
    expect(clearJson.data.userId).toBe(BOB);
    // Response.data must omit the field entirely (not return null, not return "")
    expect("readmooName" in clearJson.data).toBe(false);

    // KV roundtrip: stored record must also have no readmooName key on Bob
    const stored = (await kv.get(kvKeys.family(familyId), "json")) as RawFamilyRecord;
    const storedBob = stored.members.find((m) => m.userId === BOB);
    expect(storedBob).toBeDefined();
    expect(storedBob && "readmooName" in storedBob).toBe(false);
  });

  it("readmooName: null is idempotent when the field was never set", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: null },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect("readmooName" in json.data).toBe(false);
  });

  it("readmooName: null can be set by the member themselves (non-owner)", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // Bob sets his readmooName
    await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "BobsName" },
      bobToken,
    );

    // Bob clears it himself
    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: null },
      bobToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect("readmooName" in json.data).toBe(false);
  });

  it("rejects non-owner trying to clear another member's readmooName with 403", async () => {
    const { familyId } = await createFamilyAndGetToken(ALICE, "Alice");
    const { authToken: bobToken } = await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${ALICE}`,
      { readmooName: null },
      bobToken,
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FORBIDDEN");
  });

  it("rejects non-string-non-null readmooName (e.g. number) with 400 INVALID_FIELDS", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: 123 },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("rejects boolean readmooName with 400 INVALID_FIELDS", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: true },
      ownerToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FIELDS");
  });

  it("readmooName: undefined + canLend present → only canLend changes, readmooName preserved", async () => {
    const { familyId, authToken: ownerToken } = await createFamilyAndGetToken(ALICE, "Alice");
    await joinFamilyAndGetToken(familyId, BOB, "Bob");

    // Seed Bob with a readmooName
    await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { readmooName: "SeededName" },
      ownerToken,
    );

    // Patch only canLend (readmooName omitted entirely from body)
    const res = await request(
      "PATCH",
      `/api/family/${familyId}/member/${BOB}`,
      { canLend: BoolFlag.FALSE },
      ownerToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.canLend).toBe(BoolFlag.FALSE);
    expect(json.data.readmooName).toBe("SeededName");

    // KV roundtrip confirms preservation
    const stored = (await kv.get(kvKeys.family(familyId), "json")) as RawFamilyRecord;
    const storedBob = stored.members.find((m) => m.userId === BOB);
    expect(storedBob?.readmooName).toBe("SeededName");
    expect(storedBob?.canLend).toBe(BoolFlag.FALSE);
  });
});
