import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, BoolFlag, type ApiResponse } from "@/api/client";
import { isHexId } from "moo-family-bookshelf-shared/api/hexId";

/**
 * The issued-credential check (#350, `shared/src/api/issuedCredentials.ts`) as
 * the PWA wires it: `createFamily` runs `sanitizeIssuedFamilyGroup` (the group's
 * text layer, then the token / expiry check), and `joinFamily` — which had no
 * sanitizer at all before #350 — runs `sanitizeIssuedCredentials` over its
 * `{ ok, authToken?, expiresAt? }` answer. Driven through the public client
 * surface with `fetch` mocked, because the contract is what a caller receives
 * when a self-hosted (BYO) or broken backend answers, not the helper's shape.
 *
 * The rules: `authToken` survives only as a 64-char lowercase hex string,
 * `expiresAt` only as a finite number above 0. An unusable value loses its KEY
 * (it is not degraded), so the caller reads the payload exactly as if the server
 * had sent none — no token stored, no expiry meaning "valid until a 401". Every
 * other field passes through untouched. A dropped PRESENT key costs exactly one
 * `[issuedCredentials]` warn per payload, never carrying the value; an absent
 * key is not a defect and stays silent.
 *
 * Mirrored in `extension/tests/unit/api/issuedCredentials.test.ts`, where both
 * methods answer a whole family group.
 */

const ENDPOINT = "https://api.example.com";
const FAMILY_ID = "fam-abc123";
const USER_ID = "a".repeat(64);
const ISSUED_TOKEN = "0123456789abcdef".repeat(4);
const ISSUED_EXPIRY = 1_700_000_000_000;
const WARN_PREFIX = /^\[issuedCredentials\]/;

const VALID_GROUP = {
  familyId: FAMILY_ID,
  ownerId: USER_ID,
  members: [
    {
      userId: USER_ID,
      displayName: "小明",
      canLend: BoolFlag.TRUE,
      readmooName: "ming@readmoo",
    },
  ],
  maxMembers: 6,
  createdAt: "2026-04-26T00:00:00Z",
  apiEndpoint: "https://byo.example.com",
  authToken: ISSUED_TOKEN,
  expiresAt: ISSUED_EXPIRY,
};

const VALID_JOIN = {
  ok: true,
  authToken: ISSUED_TOKEN,
  expiresAt: ISSUED_EXPIRY,
};

const BAD_TOKENS: Array<{ name: string; value: unknown }> = [
  { name: "a short string", value: "soon" },
  { name: "63 hex chars", value: ISSUED_TOKEN.slice(1) },
  { name: "65 hex chars", value: `${ISSUED_TOKEN}a` },
  { name: "uppercase hex", value: ISSUED_TOKEN.toUpperCase() },
  { name: "a number", value: 12345 },
  { name: "an object", value: { token: ISSUED_TOKEN } },
  { name: "null", value: null },
];

const BAD_EXPIRIES: Array<{ name: string; value: unknown }> = [
  { name: "a word", value: "soon" },
  { name: "NaN", value: Number.NaN },
  { name: "Infinity", value: Number.POSITIVE_INFINITY },
  { name: "0", value: 0 },
  { name: "a negative number", value: -1 },
  { name: "a numeric string", value: "1700000000000" },
];

interface MethodCase {
  name: string;
  valid: Record<string, unknown>;
  invoke: (client: ApiClient) => Promise<ApiResponse<unknown>>;
}

const METHODS: MethodCase[] = [
  {
    name: "createFamily",
    valid: VALID_GROUP,
    invoke: (client) => client.createFamily(USER_ID, "小明"),
  },
  {
    name: "joinFamily",
    valid: VALID_JOIN,
    invoke: (client) => client.joinFamily(FAMILY_ID, USER_ID),
  },
];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

/** The same record minus the given keys. */
function omit(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  );
}

describe("ApiClient issued credentials (#350, PWA)", () => {
  const mockFetch = vi.fn();
  let client: ApiClient;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    client = new ApiClient(ENDPOINT);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Exactly one `[issuedCredentials]` warn, and it does not carry `value`. */
  function expectOneWarnWithout(...values: unknown[]): void {
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0];
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(WARN_PREFIX);
    for (const value of values) {
      if (typeof value === "string" || typeof value === "number") {
        expect(args[0]).not.toContain(String(value));
      }
    }
  }

  for (const method of METHODS) {
    describe(method.name, () => {
      it("keeps a valid authToken and expiresAt unchanged, other fields untouched", async () => {
        mockFetch.mockResolvedValue(jsonResponse({ data: method.valid }));

        const result = await method.invoke(client);
        const data = result.data as Record<string, unknown>;

        expect(data.authToken).toBe(ISSUED_TOKEN);
        expect(data.expiresAt).toBe(ISSUED_EXPIRY);
        expect(data).toEqual(method.valid);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      for (const c of BAD_TOKENS) {
        it(`drops an authToken that is ${c.name} and keeps everything else`, async () => {
          mockFetch.mockResolvedValue(
            jsonResponse({ data: { ...method.valid, authToken: c.value } }),
          );

          const result = await method.invoke(client);
          const data = result.data as Record<string, unknown>;

          expect(Object.keys(data)).not.toContain("authToken");
          expect(data.expiresAt).toBe(ISSUED_EXPIRY);
          expect(data).toEqual(omit(method.valid, "authToken"));
          expectOneWarnWithout(c.value);
        });
      }

      for (const c of BAD_EXPIRIES) {
        it(`drops an expiresAt that is ${c.name} and keeps the token`, async () => {
          mockFetch.mockResolvedValue(
            jsonResponse({ data: { ...method.valid, expiresAt: c.value } }),
          );

          const result = await method.invoke(client);
          const data = result.data as Record<string, unknown>;

          expect(Object.keys(data)).not.toContain("expiresAt");
          expect(data.authToken).toBe(ISSUED_TOKEN);
          expect(data).toEqual(omit(method.valid, "expiresAt"));
          expectOneWarnWithout(c.value);
        });
      }

      it("adds no keys and stays silent when both are absent", async () => {
        const withoutCredentials = omit(method.valid, "authToken", "expiresAt");
        mockFetch.mockResolvedValue(jsonResponse({ data: withoutCredentials }));

        const result = await method.invoke(client);
        const data = result.data as Record<string, unknown>;

        expect(Object.keys(data)).not.toContain("authToken");
        expect(Object.keys(data)).not.toContain("expiresAt");
        expect(data).toEqual(withoutCredentials);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("warns exactly once when both are present and invalid", async () => {
        mockFetch.mockResolvedValue(
          jsonResponse({
            data: { ...method.valid, authToken: "garbage", expiresAt: "soon" },
          }),
        );

        const result = await method.invoke(client);
        const data = result.data as Record<string, unknown>;

        expect(data).toEqual(omit(method.valid, "authToken", "expiresAt"));
        expectOneWarnWithout("garbage", "soon");
      });

      it("passes an error envelope through untouched and silent", async () => {
        const error = { code: "FAMILY_FULL", message: "Family is full" };
        mockFetch.mockResolvedValue(jsonResponse({ error }, 409));

        const result = await method.invoke(client);

        expect(result.data).toBeUndefined();
        expect(result.error).toEqual(error);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  }
});

// The auth-token predicate is `isHexId`; its boundary has no other direct test.
describe("isHexId", () => {
  const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
    { name: "64 lowercase hex chars", value: ISSUED_TOKEN, expected: true },
    { name: "63 chars", value: ISSUED_TOKEN.slice(1), expected: false },
    { name: "65 chars", value: `${ISSUED_TOKEN}0`, expected: false },
    {
      name: "a non-hex letter",
      value: `g${ISSUED_TOKEN.slice(1)}`,
      expected: false,
    },
    { name: "a trailing newline", value: `${ISSUED_TOKEN}\n`, expected: false },
    { name: "a non-string", value: 0, expected: false },
  ];

  for (const c of cases) {
    it(`returns ${c.expected} for ${c.name}`, () => {
      expect(isHexId(c.value)).toBe(c.expected);
    });
  }
});
