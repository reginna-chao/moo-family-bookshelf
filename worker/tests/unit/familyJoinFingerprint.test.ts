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
  const needsHash = method === "pin" || method === "pattern";
  const record: VerifyRecord = {
    method,
    hash: needsHash ? "hash-value" : null,
    salt: needsHash ? "salt-value" : null,
    prompted: 1,
    failCount: 0,
    lockedUntil: null,
  };
  await kv.put(kvKeys.verify(userId), JSON.stringify(record));
}

async function seedLockedVerifyRecord(userId: string) {
  const record: VerifyRecord = {
    method: "pin",
    hash: "hash-value",
    salt: "salt-value",
    prompted: 1,
    failCount: 5,
    lockedUntil: Date.now() + 15 * 60 * 1000,
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

  // =========================================================================
  // Solo-member fingerprint rotation on rejoin
  // =========================================================================

  it("(j) solo member rejoin with new fingerprint + no verify set → 200 OK + KV fingerprint updated", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: ALT_FP,
    });
    expect(res.status).toBe(200);

    const raw = await kv.get<{ keyFingerprint: string; members: unknown[] }>(
      kvKeys.family(familyId),
      "json",
    );
    expect(raw?.keyFingerprint).toBe(ALT_FP);
    expect(raw?.members).toHaveLength(1);
  });

  it("(k) solo member rejoin with matching fingerprint → 200 OK + KV fingerprint unchanged", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: VALID_FP,
    });
    expect(res.status).toBe(200);

    const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
    expect(raw?.keyFingerprint).toBe(VALID_FP);
  });

  it("(l) solo member rejoin without fingerprint in body → 200 OK + KV fingerprint unchanged", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
    });
    expect(res.status).toBe(200);

    const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
    expect(raw?.keyFingerprint).toBe(VALID_FP);
  });

  it("(m) multi-member family: existing member rejoin with new fingerprint → KV fingerprint UNCHANGED", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    // user2 joins with matching fingerprint → becomes 2-member family
    const joinRes = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user2",
      keyFingerprint: VALID_FP,
    });
    expect(joinRes.status).toBe(200);

    // Now user1 (existing member) rejoins with a mismatching fingerprint
    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: ALT_FP,
    });
    // Multi-member family: fingerprint mismatches → verify path runs.
    // user1 has no verify record, so validateVerification returns valid → 200 OK.
    expect(res.status).toBe(200);

    const raw = await kv.get<{ keyFingerprint: string; members: unknown[] }>(
      kvKeys.family(familyId),
      "json",
    );
    // Critical regression guard: multi-member family fingerprint MUST NOT rotate
    expect(raw?.keyFingerprint).toBe(VALID_FP);
    expect(raw?.members).toHaveLength(2);
  });

  it("(n) solo member rejoin with new fingerprint + PIN verify set + no verifySecret → 403", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);
    await seedVerifyRecord("user1", "pin");

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: ALT_FP,
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("VERIFICATION_REQUIRED");

    // Fingerprint must remain unchanged since verify gate blocked the request
    const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
    expect(raw?.keyFingerprint).toBe(VALID_FP);
  });

  it("(o) solo member rejoin with new fingerprint + PIN verify set + correct verifySecret → 200 OK + fingerprint updated", async () => {
    const { familyId } = await createFamily("user1", VALID_FP);

    // Seed a PIN verify record by computing the hash with the same algorithm
    // used by the verify route (SHA-256 of salt + secret).
    const pin = "123456";
    const salt = "0123456789abcdef0123456789abcdef";
    const data = new TextEncoder().encode(salt + pin);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const verifyRecord: VerifyRecord = {
      method: "pin",
      hash,
      salt,
      prompted: 1,
      failCount: 0,
      lockedUntil: null,
    };
    await kv.put(kvKeys.verify("user1"), JSON.stringify(verifyRecord));

    const res = await request("POST", `/api/family/${familyId}/join`, {
      userId: "user1",
      keyFingerprint: ALT_FP,
      verifySecret: pin,
    });
    expect(res.status).toBe(200);

    const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
    expect(raw?.keyFingerprint).toBe(ALT_FP);
  });

  // =========================================================================
  // recoverySource: "extension" — solo recovery verification bypass
  //
  // Threat model: the Extension runs in a browser with an active Readmoo
  // session (the same trust level used when the family was created), so solo
  // existing-member rejoin is permitted to rotate the fingerprint without
  // satisfying PWA verification. The bypass is strictly limited to
  // existing-member + solo + fingerprint-rotation rejoin.
  //
  // Regression guard for the scenario where a user reinstalls the Extension
  // after setting up PWA verification and would otherwise be locked out.
  // Cross-ref: test (n) covers the negative baseline without recoverySource.
  // =========================================================================

  describe("recoverySource extension bypass", () => {
    it("(p) solo existing + PIN verify + new fp + recoverySource=extension → 200 + fp rotated", async () => {
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedVerifyRecord("user1", "pin");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(200);

      const raw = await kv.get<{ keyFingerprint: string; members: unknown[] }>(
        kvKeys.family(familyId),
        "json",
      );
      expect(raw?.keyFingerprint).toBe(ALT_FP);
      expect(raw?.members).toHaveLength(1);
    });

    it("(q) solo existing + PATTERN verify + new fp + recoverySource=extension → 200 + fp rotated", async () => {
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedVerifyRecord("user1", "pattern");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(200);

      const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
      expect(raw?.keyFingerprint).toBe(ALT_FP);
    });

    it("(r) solo existing + CODE verify + new fp + recoverySource=extension → 200 + fp rotated", async () => {
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedVerifyRecord("user1", "code");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(200);

      const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
      expect(raw?.keyFingerprint).toBe(ALT_FP);
    });

    it("(s) solo existing + LOCKED verify + recoverySource=extension → 200 (bypass is unconditional)", async () => {
      // Critical: the bypass short-circuits the entire validateVerification
      // call, so even an actively locked-out verify record must not block a
      // legitimate Extension reinstall recovery.
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedLockedVerifyRecord("user1");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(200);

      const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
      expect(raw?.keyFingerprint).toBe(ALT_FP);
    });

    it("(t) NON-member + recoverySource=extension + verify set → 403 + fp unchanged + not added", async () => {
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedVerifyRecord("user2", "pin");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user2",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_REQUIRED");

      const raw = await kv.get<{ keyFingerprint: string; members: { userId: string }[] }>(
        kvKeys.family(familyId),
        "json",
      );
      expect(raw?.keyFingerprint).toBe(VALID_FP);
      expect(raw?.members).toHaveLength(1);
      expect(raw?.members[0].userId).toBe("user1");
    });

    it("(u) MULTI-member + existing + new fp + recoverySource=extension → 403 + fp unchanged", async () => {
      const { familyId } = await createFamily("user1", VALID_FP);
      // user2 joins with matching fp → 2-member family
      const joinRes = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user2",
        keyFingerprint: VALID_FP,
      });
      expect(joinRes.status).toBe(200);
      await seedVerifyRecord("user1", "pin");

      // user1 tries to rotate fingerprint with recoverySource — multi-member
      // families are NOT solo, so the bypass does not apply. validateVerification
      // runs, user1 has PIN set without a secret → 403.
      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: ALT_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as Json;
      expect(json.error.code).toBe("VERIFICATION_REQUIRED");

      const raw = await kv.get<{ keyFingerprint: string; members: unknown[] }>(
        kvKeys.family(familyId),
        "json",
      );
      expect(raw?.keyFingerprint).toBe(VALID_FP);
      expect(raw?.members).toHaveLength(2);
    });

    // (v) non-whitelisted recoverySource values must NOT trigger the bypass.
    // Only the exact literal "extension" is accepted.
    describe.each([
      ["pwa"],
      [""],
      ["EXTENSION"],
      ["extension "],
    ])("(v) recoverySource=%j → not bypassed", (value) => {
      it("returns 403 VERIFICATION_REQUIRED and fp unchanged", async () => {
        const { familyId } = await createFamily("user1", VALID_FP);
        await seedVerifyRecord("user1", "pin");

        const res = await request("POST", `/api/family/${familyId}/join`, {
          userId: "user1",
          keyFingerprint: ALT_FP,
          recoverySource: value,
        });
        expect(res.status).toBe(403);
        const json = (await res.json()) as Json;
        expect(json.error.code).toBe("VERIFICATION_REQUIRED");

        const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
        expect(raw?.keyFingerprint).toBe(VALID_FP);
      });
    });

    it("(w) solo existing + MATCHING fp + recoverySource=extension → 200 + fp unchanged (no rotation)", async () => {
      // Orthogonal guard: when fingerprint matches, verify is already skipped
      // by the prior branch; recoverySource must not accidentally trigger
      // rotation when fingerprints are identical.
      const { familyId } = await createFamily("user1", VALID_FP);
      await seedVerifyRecord("user1", "pin");

      const res = await request("POST", `/api/family/${familyId}/join`, {
        userId: "user1",
        keyFingerprint: VALID_FP,
        recoverySource: "extension",
      });
      expect(res.status).toBe(200);

      const raw = await kv.get<{ keyFingerprint: string }>(kvKeys.family(familyId), "json");
      expect(raw?.keyFingerprint).toBe(VALID_FP);
    });
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
