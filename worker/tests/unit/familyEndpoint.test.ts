/**
 * PUT /api/family/:id/endpoint — the BYO-backend custom API endpoint.
 *
 * The endpoint stored here is handed to every family member's client, which then
 * talks to it instead of the default Worker. The handler's URL validation is
 * therefore the only thing standing between a family owner (or anyone holding
 * the owner's token) and pointing the whole family at an arbitrary host, so the
 * host/protocol rules are pinned here case by case.
 *
 * Every mutating case asserts the stored `family:{id}` record directly, not just
 * the response body — a handler that answered 200 without writing (or that wrote
 * on a rejected request) would otherwise pass.
 *
 * The `clearEndpoint` branch of `PUT /:id/transfer` is covered at the bottom
 * because it is the only other writer of `apiEndpoint`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import app from "../../src/index";
import { createMockKV } from "../helpers/mockKv";
import { kvKeys, type FamilyRecord } from "../../src/kv/schema";
import { USER1, USER2 } from "../helpers/ids";

interface ApiEnvelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

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

function rawRequest(
  method: string,
  path: string,
  rawBody: string,
  authToken?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return app.request(
    path,
    { method, headers, body: rawBody },
    { KV: kv, DEV_MODE: "1" },
  );
}

async function readJson<T = FamilyRecord>(res: {
  json(): Promise<unknown>;
}): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>;
}

/** Read the family record straight out of KV, bypassing the API. */
function storedFamily(familyId: string): Promise<FamilyRecord | null> {
  return kv.get<FamilyRecord>(kvKeys.family(familyId), "json");
}

/**
 * Assert the family record still exists AND carries no custom endpoint.
 *
 * The existence check matters: `expect(null).not.toHaveProperty(...)` passes,
 * so a bare property assertion would also be satisfied by a record the handler
 * had wrongly deleted.
 */
async function expectNoStoredEndpoint(familyId: string) {
  const stored = await storedFamily(familyId);
  expect(stored).not.toBeNull();
  expect(stored).not.toHaveProperty("apiEndpoint");
}

async function createFamily(userId = USER1) {
  const res = await request("POST", "/api/family", { userId });
  const json = await readJson(res);
  return {
    familyId: json.data!.familyId,
    authToken: (json.data as FamilyRecord & { authToken: string }).authToken,
  };
}

/** Owner = USER1, plain member = USER2. */
async function createFamilyWithTwoMembers() {
  const { familyId, authToken: ownerToken } = await createFamily(USER1);
  const joinRes = await request("POST", `/api/family/${familyId}/join`, {
    userId: USER2,
  });
  const joinJson = await readJson(joinRes);
  const memberToken = (joinJson.data as FamilyRecord & { authToken: string })
    .authToken;
  return { familyId, ownerToken, memberToken };
}

function putEndpoint(
  familyId: string,
  apiEndpoint: unknown,
  authToken?: string,
) {
  return request(
    "PUT",
    `/api/family/${familyId}/endpoint`,
    { apiEndpoint },
    authToken,
  );
}

beforeEach(() => {
  // Fresh in-memory KV per test — no state (or TTL registry entry) survives.
  kv = createMockKV();
});

// ===========================================================================
// Happy paths
// ===========================================================================

describe("PUT /api/family/:id/endpoint success", () => {
  it("should save a valid https endpoint and return the full family record", async () => {
    const { familyId, authToken } = await createFamily(USER1);

    const res = await putEndpoint(
      familyId,
      "https://my-worker.example.workers.dev",
      authToken,
    );

    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.data).toMatchObject({
      familyId,
      ownerId: USER1,
      maxMembers: 2,
      apiEndpoint: "https://my-worker.example.workers.dev",
    });
    expect(json.data!.members).toHaveLength(1);
    expect(json.error).toBeUndefined();

    const stored = await storedFamily(familyId);
    expect(stored!.apiEndpoint).toBe("https://my-worker.example.workers.dev");
  });

  it("should replace a previously saved endpoint", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    await putEndpoint(familyId, "https://first.example.com", authToken);

    const res = await putEndpoint(
      familyId,
      "https://second.example.com",
      authToken,
    );

    expect(res.status).toBe(200);
    expect((await storedFamily(familyId))!.apiEndpoint).toBe(
      "https://second.example.com",
    );
  });

  it("should clear the endpoint when apiEndpoint is null", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    await putEndpoint(familyId, "https://custom.example.com", authToken);

    const res = await putEndpoint(familyId, null, authToken);

    expect(res.status).toBe(200);
    const json = await readJson(res);
    // Anchor the assertion so a `data: undefined` regression cannot pass vacuously.
    expect(json.data!.familyId).toBe(familyId);
    // The field is deleted, not set to null — clients read "no custom endpoint"
    // from its absence.
    expect(json.data).not.toHaveProperty("apiEndpoint");
    await expectNoStoredEndpoint(familyId);
  });

  it("should accept apiEndpoint null when no endpoint was ever set", async () => {
    const { familyId, authToken } = await createFamily(USER1);

    const res = await putEndpoint(familyId, null, authToken);

    expect(res.status).toBe(200);
    await expectNoStoredEndpoint(familyId);
  });

  it("should leave the members list and ownerId untouched", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();

    await putEndpoint(familyId, "https://custom.example.com", ownerToken);

    const stored = await storedFamily(familyId);
    expect(stored!.ownerId).toBe(USER1);
    expect(stored!.members.map((m) => m.userId)).toEqual([USER1, USER2]);
  });
});

// ===========================================================================
// URL normalization — what is actually persisted
// ===========================================================================

/**
 * `input` → value written to `family:{id}.apiEndpoint`.
 *
 * The handler stores `url.origin + url.pathname` with trailing slashes stripped,
 * so everything WHATWG `URL` normalizes away (default port, credentials, host
 * case, IDN, alternate IPv4 spellings) is normalized here too.
 */
const NORMALIZED_ENDPOINTS: [input: string, stored: string][] = [
  ["https://api.example.com", "https://api.example.com"],
  ["https://api.example.com/", "https://api.example.com"],
  ["https://api.example.com///", "https://api.example.com"],
  ["https://api.example.com/base/", "https://api.example.com/base"],
  ["https://api.example.com/a/b/////", "https://api.example.com/a/b"],
  // Non-default port is part of the origin and must survive.
  ["https://api.example.com:8443/base/", "https://api.example.com:8443/base"],
  // Default port is dropped by URL.origin.
  ["https://example.com:443/api", "https://example.com/api"],
  // Query and hash are not part of an endpoint base.
  ["https://example.com/base?q=1#frag", "https://example.com/base"],
  ["https://example.com/#/x", "https://example.com"],
  // Scheme and host lowercase; path case is preserved.
  ["HTTPS://Example.COM/API", "https://example.com/API"],
  // Surrounding whitespace is stripped by the URL parser.
  ["  https://example.com  ", "https://example.com"],
  // HTTP is allowed only for the loopback carve-out.
  ["http://localhost:8787", "http://localhost:8787"],
  ["http://LOCALHOST:8787", "http://localhost:8787"],
  ["http://127.0.0.1", "http://127.0.0.1"],
  ["https://localhost", "https://localhost"],
  ["https://LOCALHOST", "https://localhost"],
  // Alternate IPv4 spellings of 127.0.0.1 are normalized by the URL parser
  // BEFORE the host rules see them, so they land in the same loopback
  // carve-out as the dotted form and are stored in dotted form.
  ["https://2130706433", "https://127.0.0.1"],
  // The http carve-out is evaluated on the NORMALIZED hostname, so a decimal
  // loopback is accepted over http exactly like the dotted form.
  ["http://2130706433", "http://127.0.0.1"],
  ["https://0x7f000001", "https://127.0.0.1"],
  ["https://0177.0.0.1", "https://127.0.0.1"],
  ["https://127.1", "https://127.0.0.1"],
  // Leading zeros mean octal: 010 is 8, so this is the PUBLIC host 8.0.0.1 —
  // both here and in any client that later fetches it.
  ["https://010.0.0.1", "https://8.0.0.1"],
  // IDN host is punycode-encoded.
  ["https://例え.テスト", "https://xn--r8jz45g.xn--zckzah"],
];

describe("PUT /api/family/:id/endpoint normalization", () => {
  it.each(NORMALIZED_ENDPOINTS)(
    "should store %j as %j",
    async (input, expected) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, input, authToken);

      expect(res.status).toBe(200);
      expect((await readJson(res)).data!.apiEndpoint).toBe(expected);
      expect((await storedFamily(familyId))!.apiEndpoint).toBe(expected);
    },
  );

  it("should drop userinfo credentials from the stored endpoint", async () => {
    const { familyId, authToken } = await createFamily(USER1);

    const res = await putEndpoint(
      familyId,
      "https://user:pass@example.com/api",
      authToken,
    );

    expect(res.status).toBe(200);
    const saved = (await storedFamily(familyId))!.apiEndpoint;
    expect(saved).toBe("https://example.com/api");
    expect(saved).not.toContain("user");
    expect(saved).not.toContain("pass");
  });
});

// ===========================================================================
// Permission and ownership
// ===========================================================================

describe("PUT /api/family/:id/endpoint permissions", () => {
  it("should return 401 UNAUTHORIZED without an auth token", async () => {
    const { familyId } = await createFamily(USER1);

    const res = await putEndpoint(familyId, "https://custom.example.com");

    expect(res.status).toBe(401);
    expect((await readJson(res)).error!.code).toBe("UNAUTHORIZED");
    await expectNoStoredEndpoint(familyId);
  });

  it("should return 404 NOT_FOUND for a member of a different family", async () => {
    const outsider = await createFamily(USER2);
    const target = await createFamily(USER1);

    const res = await putEndpoint(
      target.familyId,
      "https://custom.example.com",
      outsider.authToken,
    );

    expect(res.status).toBe(404);
    expect((await readJson(res)).error!.code).toBe("NOT_FOUND");
    await expectNoStoredEndpoint(target.familyId);
  });

  it("should return 404 NOT_FOUND for an authenticated user with no family", async () => {
    const outsider = await createFamily(USER2);
    const target = await createFamily(USER1);
    // Keep the token valid but drop the membership reverse lookup.
    await kv.delete(kvKeys.member(USER2));

    const res = await putEndpoint(
      target.familyId,
      "https://custom.example.com",
      outsider.authToken,
    );

    expect(res.status).toBe(404);
    expect((await readJson(res)).error!.code).toBe("NOT_FOUND");
  });

  it("should reject a non-member BEFORE parsing the body", async () => {
    const outsider = await createFamily(USER2);
    const target = await createFamily(USER1);

    const res = await rawRequest(
      "PUT",
      `/api/family/${target.familyId}/endpoint`,
      "{not valid json}",
      outsider.authToken,
    );

    // The membership check runs before body parsing, so a non-member never
    // learns whether their payload was well-formed.
    expect(res.status).toBe(404);
    expect((await readJson(res)).error!.code).toBe("NOT_FOUND");
  });

  it("should return 403 NOT_OWNER for a member who is not the owner", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();

    const res = await putEndpoint(
      familyId,
      "https://custom.example.com",
      memberToken,
    );

    expect(res.status).toBe(403);
    const json = await readJson(res);
    expect(json.error!.code).toBe("NOT_OWNER");
    expect(json.error!.message).toBe("只有管理者可以修改 API 端點");
    await expectNoStoredEndpoint(familyId);
  });

  it("should reject a non-owner's INVALID url with 400, not 403", async () => {
    const { familyId, memberToken } = await createFamilyWithTwoMembers();

    const res = await putEndpoint(
      familyId,
      "ftp://custom.example.com",
      memberToken,
    );

    // URL validation runs ahead of the ownership check, so a non-owner sees the
    // validation error first. Pinned because it means the endpoint doubles as a
    // URL validator for any family member.
    expect(res.status).toBe(400);
    expect((await readJson(res)).error!.code).toBe("INVALID_ENDPOINT");
  });

  it("should return 404 FAMILY_NOT_FOUND when the family record is gone", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    // Orphaned membership: member:{userId} still points here, family record does not exist.
    await kv.delete(kvKeys.family(familyId));

    const res = await putEndpoint(
      familyId,
      "https://custom.example.com",
      authToken,
    );

    expect(res.status).toBe(404);
    expect((await readJson(res)).error!.code).toBe("FAMILY_NOT_FOUND");
    expect(await storedFamily(familyId)).toBeNull();
  });
});

// ===========================================================================
// Request-shape validation
// ===========================================================================

describe("PUT /api/family/:id/endpoint request validation", () => {
  it("should return 400 INVALID_FAMILY_ID for a malformed family id", async () => {
    const { authToken } = await createFamily(USER1);

    const res = await putEndpoint(
      "INVALID",
      "https://custom.example.com",
      authToken,
    );

    expect(res.status).toBe(400);
    expect((await readJson(res)).error!.code).toBe("INVALID_FAMILY_ID");
  });

  it("should return 401 for a malformed family id without a token", async () => {
    await createFamily(USER1);

    const res = await putEndpoint("INVALID", "https://custom.example.com");

    // The auth middleware runs before the handler, so the missing token wins
    // over the handler's own family-id check.
    expect(res.status).toBe(401);
    expect((await readJson(res)).error!.code).toBe("UNAUTHORIZED");
  });

  it("should return 400 INVALID_JSON for a malformed body", async () => {
    const { familyId, authToken } = await createFamily(USER1);

    const res = await rawRequest(
      "PUT",
      `/api/family/${familyId}/endpoint`,
      "{not valid json}",
      authToken,
    );

    expect(res.status).toBe(400);
    expect((await readJson(res)).error!.code).toBe("INVALID_JSON");
    await expectNoStoredEndpoint(familyId);
  });

  const MISSING_FIELD_BODIES: [label: string, rawBody: string][] = [
    ["an empty object", "{}"],
    ["a JSON null body", "null"],
    ["an array body", "[]"],
    ["an unrelated key", '{"endpoint":"https://example.com"}'],
  ];

  it.each(MISSING_FIELD_BODIES)(
    "should return 400 MISSING_FIELDS for %s",
    async (_label, rawBody) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await rawRequest(
        "PUT",
        `/api/family/${familyId}/endpoint`,
        rawBody,
        authToken,
      );

      expect(res.status).toBe(400);
      const json = await readJson(res);
      expect(json.error!.code).toBe("MISSING_FIELDS");
      expect(json.error!.message).toBe("apiEndpoint is required");
      await expectNoStoredEndpoint(familyId);
    },
  );

  const NON_STRING_VALUES: [label: string, value: unknown][] = [
    ["a number", 42],
    ["an object", { url: "https://example.com" }],
    ["an array", ["https://example.com"]],
    ["true", true],
    ["false", false],
  ];

  it.each(NON_STRING_VALUES)(
    "should return 400 INVALID_ENDPOINT when apiEndpoint is %s",
    async (_label, value) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, value, authToken);

      expect(res.status).toBe(400);
      const json = await readJson(res);
      expect(json.error!.code).toBe("INVALID_ENDPOINT");
      expect(json.error!.message).toBe("apiEndpoint must be a string or null");
      await expectNoStoredEndpoint(familyId);
    },
  );

  it("should accept a URL of exactly 2048 characters", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    const base = "https://example.com/";
    const url = base + "a".repeat(2048 - base.length);
    expect(url).toHaveLength(2048);

    const res = await putEndpoint(familyId, url, authToken);

    expect(res.status).toBe(200);
    expect((await storedFamily(familyId))!.apiEndpoint).toHaveLength(2048);
  });

  it("should return 400 INVALID_ENDPOINT for a URL longer than 2048 characters", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    const base = "https://example.com/";
    const url = base + "a".repeat(2049 - base.length);

    const res = await putEndpoint(familyId, url, authToken);

    expect(res.status).toBe(400);
    const json = await readJson(res);
    expect(json.error!.code).toBe("INVALID_ENDPOINT");
    expect(json.error!.message).toBe("API endpoint URL is too long");
    await expectNoStoredEndpoint(familyId);
  });

  const UNPARSEABLE_URLS: [label: string, value: string][] = [
    ["an empty string", ""],
    ["a blank string", " "],
    ["a bare hostname", "example.com"],
    ["a scheme-relative url", "//example.com"],
    ["arbitrary text", "not-a-url"],
    ["a scheme with no host", "https://"],
  ];

  it.each(UNPARSEABLE_URLS)(
    "should return 400 INVALID_ENDPOINT for %s",
    async (_label, value) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, value, authToken);

      expect(res.status).toBe(400);
      const json = await readJson(res);
      expect(json.error!.code).toBe("INVALID_ENDPOINT");
      expect(json.error!.message).toBe("apiEndpoint must be a valid URL");
      await expectNoStoredEndpoint(familyId);
    },
  );
});

// ===========================================================================
// Protocol + host rules (SSRF boundary)
// ===========================================================================

const REJECTED_PROTOCOLS: [label: string, value: string][] = [
  ["plain http on a public host", "http://api.example.com"],
  ["http on a private IP", "http://10.0.0.1"],
  ["ftp", "ftp://api.example.com"],
  ["websocket", "ws://api.example.com"],
  ["javascript", "javascript:alert(1)"],
  ["file", "file:///etc/passwd"],
];

const BLOCKED_HOSTS: [label: string, value: string][] = [
  ["10/8 start", "https://10.0.0.1"],
  ["10/8 end", "https://10.255.255.255"],
  ["172.16/12 start", "https://172.16.0.1"],
  ["172.16/12 end", "https://172.31.255.254"],
  ["192.168/16", "https://192.168.1.1"],
  ["169.254/16 link-local", "https://169.254.169.254"],
  ["0/8 unspecified", "https://0.0.0.0"],
  ["0/8 other", "https://0.1.2.3"],
  // Alternate spellings the URL parser resolves back into a blocked range
  // before the host rules run.
  ["hex form of 10.0.0.1", "https://0x0a000001"],
  ["trailing-dot form of 10.0.0.1", "https://10.0.0.1."],
];

/** Public addresses that sit just outside each blocked range. */
const ALLOWED_NEIGHBOUR_HOSTS: [label: string, value: string][] = [
  ["just below 10/8", "https://9.255.255.255"],
  ["just above 10/8", "https://11.0.0.1"],
  ["just below 172.16/12", "https://172.15.255.255"],
  ["just above 172.16/12", "https://172.32.0.1"],
  ["just above 192.168/16", "https://192.169.0.1"],
  ["just below 169.254/16", "https://169.253.0.1"],
  ["a public address", "https://1.2.3.4"],
];

describe("PUT /api/family/:id/endpoint protocol rules", () => {
  it.each(REJECTED_PROTOCOLS)(
    "should return 400 INVALID_ENDPOINT for %s",
    async (_label, value) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, value, authToken);

      expect(res.status).toBe(400);
      const json = await readJson(res);
      expect(json.error!.code).toBe("INVALID_ENDPOINT");
      expect(json.error!.message).toBe(
        "API endpoint must use HTTPS (or HTTP for localhost)",
      );
      await expectNoStoredEndpoint(familyId);
    },
  );
});

describe("PUT /api/family/:id/endpoint private-host rules", () => {
  it.each(BLOCKED_HOSTS)(
    "should return 400 INVALID_ENDPOINT for %s",
    async (_label, value) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, value, authToken);

      expect(res.status).toBe(400);
      const json = await readJson(res);
      expect(json.error!.code).toBe("INVALID_ENDPOINT");
      expect(json.error!.message).toBe(
        "Private or internal IP addresses are not allowed",
      );
      await expectNoStoredEndpoint(familyId);
    },
  );

  it.each(ALLOWED_NEIGHBOUR_HOSTS)(
    "should accept %s",
    async (_label, value) => {
      const { familyId, authToken } = await createFamily(USER1);

      const res = await putEndpoint(familyId, value, authToken);

      expect(res.status).toBe(200);
      expect((await storedFamily(familyId))!.apiEndpoint).toBe(value);
    },
  );

  it("should keep the previously saved endpoint when an update is rejected", async () => {
    const { familyId, authToken } = await createFamily(USER1);
    await putEndpoint(familyId, "https://good.example.com", authToken);

    const res = await putEndpoint(familyId, "https://192.168.0.1", authToken);

    expect(res.status).toBe(400);
    // A rejected update must not clear or overwrite what was already stored.
    expect((await storedFamily(familyId))!.apiEndpoint).toBe(
      "https://good.example.com",
    );
  });
});

// ===========================================================================
// PUT /api/family/:id/transfer — clearEndpoint branch
// ===========================================================================

/** `clearEndpoint` is checked with `=== 1`; every other value is a no-op. */
const CLEAR_ENDPOINT_CASES: [
  outcome: string,
  clearEndpoint: unknown,
  cleared: boolean,
][] = [
  ["clear", 1, true],
  ["keep", 0, false],
  ["keep", "1", false],
  ["keep", true, false],
  ["keep", null, false],
];

describe("PUT /api/family/:id/transfer clearEndpoint", () => {
  async function setUpFamilyWithEndpoint() {
    const { familyId, ownerToken, memberToken } =
      await createFamilyWithTwoMembers();
    await putEndpoint(familyId, "https://custom.example.com", ownerToken);
    return { familyId, ownerToken, memberToken };
  }

  it.each(CLEAR_ENDPOINT_CASES)(
    "should %s the endpoint on transfer when clearEndpoint is %j",
    async (_outcome, clearEndpoint, cleared) => {
      const { familyId, ownerToken } = await setUpFamilyWithEndpoint();

      const res = await request(
        "PUT",
        `/api/family/${familyId}/transfer`,
        { newOwnerId: USER2, clearEndpoint },
        ownerToken,
      );

      expect(res.status).toBe(200);
      const json = await readJson(res);
      const stored = await storedFamily(familyId);
      expect(json.data!.familyId).toBe(familyId);
      expect(stored!.ownerId).toBe(USER2);
      if (cleared) {
        expect(json.data).not.toHaveProperty("apiEndpoint");
        await expectNoStoredEndpoint(familyId);
      } else {
        expect(json.data!.apiEndpoint).toBe("https://custom.example.com");
        expect(stored!.apiEndpoint).toBe("https://custom.example.com");
      }
    },
  );

  it("should keep the endpoint when clearEndpoint is omitted", async () => {
    const { familyId, ownerToken } = await setUpFamilyWithEndpoint();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: USER2 },
      ownerToken,
    );

    expect(res.status).toBe(200);
    const stored = await storedFamily(familyId);
    expect(stored!.ownerId).toBe(USER2);
    expect(stored!.apiEndpoint).toBe("https://custom.example.com");
  });

  it("should transfer normally when clearEndpoint is 1 but no endpoint is set", async () => {
    const { familyId, ownerToken } = await createFamilyWithTwoMembers();

    const res = await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: USER2, clearEndpoint: 1 },
      ownerToken,
    );

    expect(res.status).toBe(200);
    expect((await storedFamily(familyId))!.ownerId).toBe(USER2);
    await expectNoStoredEndpoint(familyId);
  });

  it("should let the new owner set the endpoint after a transfer", async () => {
    const { familyId, ownerToken, memberToken } =
      await setUpFamilyWithEndpoint();
    await request(
      "PUT",
      `/api/family/${familyId}/transfer`,
      { newOwnerId: USER2, clearEndpoint: 1 },
      ownerToken,
    );

    const newOwnerRes = await putEndpoint(
      familyId,
      "https://new-owner.example.com",
      memberToken,
    );
    const oldOwnerRes = await putEndpoint(
      familyId,
      "https://old-owner.example.com",
      ownerToken,
    );

    expect(newOwnerRes.status).toBe(200);
    expect(oldOwnerRes.status).toBe(403);
    expect((await storedFamily(familyId))!.apiEndpoint).toBe(
      "https://new-owner.example.com",
    );
  });
});
