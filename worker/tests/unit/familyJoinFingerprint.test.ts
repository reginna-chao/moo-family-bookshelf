import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, type VerifyRecord } from "../../src/kv/schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const VALID_FP = "a".repeat(64);
const ALT_FP = "b".repeat(64);

let kv: KVNamespace;

function request(method: string, path: string, body?: unknown, authToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

async function createFamily(userId = "user1", fingerprint = VALID_FP) {
  const res = await request("POST", "/api/family", { userId, keyFingerprint: fingerprint });
  expect(res.status).toBe(201);
  const json = (await res.json()) as Json;
  return {
    familyId: json.data.familyId as string,
    authToken: json.data.authToken as string,
  };
}

async function seedVerifyRecord(userId: string, method: VerifyRecord["method"]) {
  const record: VerifyRecord = {
    method,
    hash: method === "pin" ? "hash-value" : null,
    salt: method === "pin" ? "salt-value" : null,
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
// POST /api/family — keyFingerprint validation on create
// ===========================================================================

describe("POST /api/family — keyFingerprint validation", () => {
  it("(a) should return 400 MISSING_KEY_FINGERPRINT when keyFingerprint is absent", async () => {
    const res = await request("POST", "/api/family", { userId: "user1" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_KEY_FINGERPRINT");
  });

  it("(a) should return 400 MISSING_KEY_FINGERPRINT when keyFingerprint is null", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: null });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("MISSING_KEY_FINGERPRINT");
  });

  it("(b) should return 400 INVALID_KEY_FINGERPRINT for non-hex fingerprint", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: "not-hex!!" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_KEY_FINGERPRINT");
  });

  it("(b) should return 400 INVALID_KEY_FINGERPRINT for 63-char hex (too short)", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: "a".repeat(63) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_KEY_FINGERPRINT");
  });

  it("(b) should return 400 INVALID_KEY_FINGERPRINT for uppercase hex", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: "A".repeat(64) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_KEY_FINGERPRINT");
  });

  it("(c) should store keyFingerprint in KV on successful create", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    const familyId = json.data.familyId as string;

    const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
    expect(raw?.keyFingerprint).toBe(VALID_FP);
  });

  it("(c) should NOT expose keyFingerprint in create response body", async () => {
    const res = await request("POST", "/api/family", { userId: "user1", keyFingerprint: VALID_FP });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Json;
    expect(json.data.keyFingerprint).toBeUndefined();
  });
});

// ===========================================================================
// POST /api/family/:id/join — keyFingerprint bypass logic
// ===========================================================================

describe("POST /api/family/:id/join — fingerprint bypass verify", () => {
  it("(d) fingerprint matches + user has PIN → skips verify → 200 OK", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user2", "pin");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.authToken).toBeDefined();
  });

  it("(e) fingerprint matches + user has OTP method → OTP deadlock resolved → 200 OK", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    // Seed OTP verify record but no otp:{userId} key (simulates mid-session OTP)
    await seedVerifyRecord("user2", "code");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.authToken).toBeDefined();
  });

  it("(f) fingerprint does not match + user has PIN → runs verify → 403 VERIFICATION_REQUIRED", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user2", "pin");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: ALT_FP,
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("(g) no fingerprint in body + user has PIN → runs verify → 403 VERIFICATION_REQUIRED", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user2", "pin");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("(h) keyFingerprint with invalid format on join → 400 INVALID_KEY_FINGERPRINT", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: "not-valid-hex",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_KEY_FINGERPRINT");
  });

  it("(i) attacker knows userId, sends empty string fingerprint → 403 VERIFICATION_REQUIRED", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user2", "pin");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: "",
    });
    // Empty string fails isValidKeyFingerprint → 400
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_KEY_FINGERPRINT");
  });

  it("existing member rejoin with matching fingerprint → 200 OK without verify", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user1", "pin");

    // user1 (existing member) rejoins using fingerprint — no verifySecret needed
    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.authToken).toBeDefined();
    // Member list should not duplicate
    expect(json.data.members).toHaveLength(1);
  });

  it("join response should not expose keyFingerprint", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.keyFingerprint).toBeUndefined();
  });

  it("should return 500 when family record in KV is missing keyFingerprint (corruption guard)", async () => {
    const familyId = "corr-0001";
    // Seed a family record without keyFingerprint — simulates corrupted/legacy KV data.
    await kv.put(
      kvKeys.family(familyId),
      JSON.stringify({
        familyId,
        ownerId: "user1",
        members: [{ userId: "user1", displayName: "Test" }],
        maxMembers: 2,
        createdAt: new Date().toISOString(),
      }),
    );

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(500);
  });
});
