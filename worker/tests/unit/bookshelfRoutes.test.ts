import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys } from "../../src/kv/schema";
import { USER1 } from "../helpers/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

function request(
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamilyAndGetToken(userId = USER1) {
  const res = await request("POST", "/api/family", { userId });
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
// GET /api/family/:id/bookshelf — validation branches
// ===========================================================================

describe("GET /api/family/:id/bookshelf validation", () => {
  it("should return 400 INVALID_FAMILY_ID for malformed family ID", async () => {
    const { authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "GET",
      "/api/family/INVALID/bookshelf",
      undefined,
      authToken,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 401 UNAUTHORIZED when not authenticated", async () => {
    const res = await request("GET", "/api/family/abcd-1234/bookshelf");
    expect(res.status).toBe(401);
  });

  it("should return 404 FAMILY_NOT_FOUND when family record is missing from KV", async () => {
    const { familyId, authToken } = await createFamilyAndGetToken(USER1);

    // Delete the family record from KV but keep the member mapping
    await kv.delete(kvKeys.family(familyId));

    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      authToken,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("should return members with empty books array when no books saved", async () => {
    const { familyId, authToken } = await createFamilyAndGetToken(USER1);

    const res = await request(
      "GET",
      `/api/family/${familyId}/bookshelf`,
      undefined,
      authToken,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.members[0].books).toEqual([]);
    expect(json.data.members[0].lastUpdated).toBeNull();
  });
});
