import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { seedAuthToken } from "../helpers/auth";
import { kvKeys, TOKEN_TTL_SECONDS } from "../../src/kv/schema";
import { hashAuthToken } from "../../src/utils/crypto";

/**
 * `POST /api/auth/refresh` through the app: input checks, the optional
 * familyId membership check, and the #425 renewal — the presented token comes
 * back as the same string with its `token:{hash}` slid to 90 days, and
 * `auth:{userId}` is not rewritten. A TTL gap (no `auth:` record) mints a
 * new listed token. Seeded tokens are 10 days old: old enough that the slide
 * writes, young enough to be far from the 180-day cap (whose edges live in
 * `renewPresentedAuthToken.test.ts`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let kv: KVNamespace;

const VALID_USER_ID = "a".repeat(64); // 64-char hex
const VALID_FAMILY_ID = "abcd-1234";
const TEN_DAYS_AGO = new Date(
  Date.now() - 10 * 24 * 60 * 60 * 1000,
).toISOString();

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
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Seed KV with a member mapping and optionally a listed auth token. */
async function seedMember(userId: string, familyId: string, oldToken?: string) {
  await kv.put(kvKeys.member(userId), familyId);
  if (oldToken) {
    await seedAuthToken(kv, userId, {
      token: oldToken,
      createdAt: TEN_DAYS_AGO,
    });
  }
}

/** A token that authenticates, for the input-validation cases. */
function seedBearer(token: string): Promise<string> {
  return seedAuthToken(kv, VALID_USER_ID, { token });
}

beforeEach(() => {
  kv = createMockKV();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/refresh", () => {
  it("should return 401 without Authorization header (now protected)", async () => {
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("should return a token with valid Authorization header", async () => {
    const oldToken = "f".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.expiresAt).toBeTypeOf("number");
    expect(json.data.expiresAt).toBeGreaterThan(Date.now());
  });

  it("should hand back the presented token and keep it listed", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);
    const hash = await hashAuthToken(oldToken);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toBe(oldToken);
    const tokenRecord = (await kv.get(kvKeys.authToken(hash), "json")) as Json;
    expect(tokenRecord.userId).toBe(VALID_USER_ID);
    const authRecord = (await kv.get(
      kvKeys.auth(VALID_USER_ID),
      "json",
    )) as Json;
    expect(authRecord.tokens.map((e: Json) => e.hash)).toEqual([hash]);
  });

  it("should slide only token:{hash} to 90 days and never re-put auth:", async () => {
    const oldToken = "b".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, oldToken);
    // Spy after seeding so only the refresh's puts are captured.
    const putSpy = vi.spyOn(kv, "put");

    const before = Date.now();
    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toBe(oldToken);
    expect(json.data.expiresAt).toBeGreaterThanOrEqual(
      before + TOKEN_TTL_SECONDS * 1000,
    );
    expect(json.data.expiresAt).toBeLessThanOrEqual(
      Date.now() + TOKEN_TTL_SECONDS * 1000,
    );

    const hash = await hashAuthToken(oldToken);
    const putKeys = putSpy.mock.calls.map(([k]) => k);
    // The token's index key goes first, with the same TTL (#431).
    expect(putKeys).toEqual([
      kvKeys.authTokenIndex(VALID_USER_ID, hash),
      kvKeys.authToken(hash),
    ]);
    for (const call of putSpy.mock.calls)
      expect(call[2]).toMatchObject({ expirationTtl: TOKEN_TTL_SECONDS });
  });

  it("should return 401 when token belongs to different user than body.userId", async () => {
    const otherUserId = "c".repeat(64);
    const token = "d".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID);
    await seedMember(otherUserId, VALID_FAMILY_ID, token);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should return 400 for invalid userId format (too short)", async () => {
    const token = await seedBearer("e".repeat(64));

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: "abc123", familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid userId format (uppercase hex)", async () => {
    const token = await seedBearer("e".repeat(64));

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: "A".repeat(64),
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for missing userId", async () => {
    const token = await seedBearer("e".repeat(64));

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ familyId: VALID_FAMILY_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should succeed without familyId (v1.2.0: familyId is optional)", async () => {
    const token = "e".repeat(64);
    await seedAuthToken(kv, VALID_USER_ID, { token, createdAt: TEN_DAYS_AGO });

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toBe(token);
  });

  it("should return 400 for empty familyId", async () => {
    const token = await seedBearer("e".repeat(64));

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({ userId: VALID_USER_ID, familyId: "" }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 for invalid JSON body", async () => {
    const token = await seedBearer("e".repeat(64));

    const res = await request("POST", "/api/auth/refresh", {
      body: "not json",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should return 401 when userId belongs to a different family", async () => {
    const token = "f".repeat(64);
    await seedMember(VALID_USER_ID, "wxyz-9876", token);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("REFRESH_FAILED");
  });

  it("should mint a new listed token when there is no auth record (TTL gap)", async () => {
    const token = "f".repeat(64);
    // Deliberate asymmetric seed: token:{hash} authenticates the request, but
    // auth:{userId} is absent, so the refresh mints a fresh token.
    await seedAuthToken(kv, VALID_USER_ID, { token });
    await kv.delete(kvKeys.auth(VALID_USER_ID));
    await kv.put(kvKeys.member(VALID_USER_ID), VALID_FAMILY_ID);

    const res = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(json.data.token).not.toBe(token);
    expect(json.data.expiresAt).toBeTypeOf("number");

    // The mint must persist both halves, or the new token would not
    // authenticate the next request.
    const hash = await hashAuthToken(json.data.token);
    const authRecord = (await kv.get(
      kvKeys.auth(VALID_USER_ID),
      "json",
    )) as Json;
    expect(authRecord.tokens.map((e: Json) => e.hash)).toEqual([hash]);
    const tokenRecord = (await kv.get(kvKeys.authToken(hash), "json")) as Json;
    expect(tokenRecord.userId).toBe(VALID_USER_ID);
  });

  it("should return same token on consecutive refreshes with same auth", async () => {
    const token = "f".repeat(64);
    await seedMember(VALID_USER_ID, VALID_FAMILY_ID, token);

    const res1 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${token}` },
    });
    const json1 = (await res1.json()) as Json;

    // Use the returned token for the second request
    const res2 = await request("POST", "/api/auth/refresh", {
      body: JSON.stringify({
        userId: VALID_USER_ID,
        familyId: VALID_FAMILY_ID,
      }),
      headers: { Authorization: `Bearer ${json1.data.token}` },
    });
    const json2 = (await res2.json()) as Json;

    expect(res2.status).toBe(200);
    expect(json1.data.token).toBe(token);
    expect(json2.data.token).toBe(token);
    expect(json2.data.expiresAt).toBe(json1.data.expiresAt);
  });
});
