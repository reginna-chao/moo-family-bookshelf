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
  return app.request(path, init, { KV: kv, DEV_MODE: "1" });
}

/** Helper: compute userId from email (same as client-side sha256Hex). */
async function computeUserId(email: string): Promise<string> {
  const normalized = email.toLowerCase().trim();
  const encoded = new TextEncoder().encode(`moo:${normalized}`);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Helper: create a family for a given userId, returns familyId + authToken. */
async function createFamily(userId: string): Promise<{ familyId: string; authToken: string }> {
  const res = await app.request(
    "/api/family",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, keyFingerprint: "a".repeat(64) }),
    },
    { KV: kv, DEV_MODE: "1" },
  );
  const json = (await res.json()) as Json;
  return { familyId: json.data.familyId as string, authToken: json.data.authToken as string };
}

beforeEach(() => {
  kv = createMockKV();
});

describe("POST /api/auth/lookup", () => {
  it("should return existingFamilyId null and memberCount 0 for unknown userId", async () => {
    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: "a".repeat(64) }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBeNull();
    expect(json.data.memberCount).toBe(0);
  });

  it("should return correct family info when user has a family", async () => {
    const userId = await computeUserId("lookup-test@example.com");
    const { familyId } = await createFamily(userId);

    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Json;
    expect(json.data.existingFamilyId).toBe(familyId);
    expect(json.data.memberCount).toBe(1);
  });

  it("should return 400 for invalid userId format", async () => {
    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: "not-a-hex-id" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_INPUT");
  });

  it("should return 400 when userId is missing", async () => {
    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("should return 400 for invalid JSON body", async () => {
    const res = await request("POST", "/api/auth/lookup", {
      body: "not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as Json;
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("should not require authentication", async () => {
    const res = await request("POST", "/api/auth/lookup", {
      body: JSON.stringify({ userId: "b".repeat(64) }),
    });
    expect(res.status).toBe(200);
  });
});
