import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import { ApiError, BoolFlag } from "@/api/types";
import type {
  ApiResponse,
  FamilyGroup,
  FamilyMember,
  MemberSettingsPayload,
} from "@/api/types";

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

const MOCK_ENDPOINT = "https://test.workers.dev";
const FAMILY_ID = "fam-abc";
const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);

function mockFetchSuccess<T>(data: T, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  });
}

function mockFetchError(code: string, message: string, status = 400) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code, message } }),
  });
}

/**
 * Serve a whole envelope verbatim — the only way to reach the shapes a
 * `{ data }`-only helper cannot build: a 200 that carries `error` alongside
 * `data`, an `error: null`, or no `data` key at all.
 */
function mockFetchEnvelope(envelope: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(envelope),
  });
}

function makeMember(overrides: Partial<FamilyMember> = {}): FamilyMember {
  return {
    userId: USER_A,
    displayName: "Alice",
    canLend: BoolFlag.TRUE,
    readmooName: "alice@readmoo",
    ...overrides,
  };
}

function makeGroup(overrides: Partial<FamilyGroup> = {}): FamilyGroup {
  return {
    familyId: FAMILY_ID,
    ownerId: USER_A,
    members: [makeMember()],
    maxMembers: 6,
    createdAt: "2026-04-26T00:00:00Z",
    ...overrides,
  };
}

/** The rejection reason, typed — `rejects.toThrow` cannot inspect fields. */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/*
 * Member-shape fixtures shared by both payload-validation suites below: the
 * list (`getFamilyMembers`) and the single object (`updateMemberSettings`) go
 * through the SAME `sanitizeFamilyMember` rules, so one set of tables is what
 * keeps the two suites from asserting subtly different criteria.
 */

/** Exactly the keys `FamilyMember` declares — the sanitized member's key set. */
const MEMBER_KEYS = ["userId", "displayName", "canLend", "readmooName"];
const SORTED_MEMBER_KEYS = [...MEMBER_KEYS].sort();

/** Read a value as a bag of unknowns — the tables feed fields the type forbids. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** A valid member with one field replaced by an untrusted value. */
function withField(field: string, value: unknown): Record<string, unknown> {
  return { ...makeMember(), [field]: value };
}

/** A valid member with one field absent entirely. */
function withoutField(field: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(makeMember()).filter(([key]) => key !== field),
  );
}

/** Values that are not strings — reused by both string-typed fields. */
const NON_STRING_VALUES: Array<{ name: string; value: unknown }> = [
  { name: "a number", value: 42 },
  { name: "null", value: null },
  { name: "undefined", value: undefined },
  { name: "an object", value: { nested: "x" } },
  { name: "an array", value: ["x"] },
  { name: "a boolean", value: false },
];

/** Values that are not exactly one of the two `BoolFlag` members. */
const INVALID_CANLEND: Array<{ name: string; value: unknown }> = [
  { name: "the boolean true", value: true },
  { name: "the boolean false", value: false },
  { name: 'the string "1"', value: "1" },
  { name: 'the string "0"', value: "0" },
  { name: "an out-of-range number", value: 2 },
  { name: "a negative number", value: -1 },
  { name: "null", value: null },
  { name: "an object", value: { canLend: 1 } },
  { name: "an array", value: [1] },
];

describe("ApiClient getFamilyMembers", () => {
  let client: ApiClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
    client.setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("request wiring", () => {
    it("sends GET to /api/family/:id/members and returns the group envelope", async () => {
      const group = makeGroup();
      globalThis.fetch = mockFetchSuccess(group);

      const result = await client.getFamilyMembers(FAMILY_ID);

      // The group comes back as sent, plus the `apiEndpoint` the sanitizer
      // always emits — `null` here because the fixture omits the key. The
      // normalization itself is covered in its own suite below.
      expect(result.data).toEqual({ ...group, apiEndpoint: null });
      expect(result.error).toBeUndefined();
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/family/${FAMILY_ID}/members`);
      // Default fetch init has no method (GET)
      expect(call[1]?.method ?? "GET").toBe("GET");
      expect(call[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      );
    });
  });

  /**
   * Runtime boundary validation of the member-list payload.
   *
   * Driven through the public `getFamilyMembers` surface instead of importing
   * `sanitizeFamilyMembersResponse` directly: the contract is what a caller
   * receives when a self-hosted (BYO) or hostile backend answers, not the shape
   * of the helper. Unlike the borrow list, this method hands back the whole
   * `{ data, error }` envelope — callers unwrap it themselves — so the
   * passthrough cases below are about the envelope, not about a thrown error.
   *
   * Driving the public surface means what these cases pin is the COMPOSED
   * contract of the TWO layers `getFamilyMembers` wires, in this order:
   *  1. `extension/src/api/memberValidation.ts` — the STRUCTURAL rebuild. Drops
   *     elements that cannot be addressed, rebuilds each survivor from at most
   *     the four `FamilyMember` keys (so hostile extras and a non-string
   *     optional lose their key rather than degrade), always emits
   *     `apiEndpoint`, and refuses to touch an envelope carrying an `error`.
   *  2. `shared/src/api/entityText.ts` — the declared-STRING coercion, which
   *     then hardens the three group-level text fields (`familyId` / `ownerId` /
   *     `createdAt`) that layer 1 documents as out of its own scope, and re-runs
   *     over the already-rebuilt members as a no-op.
   * Where a case can tell the two apart it says so, because a regression in
   * either layer must fail here instead of being absorbed by the other.
   *
   * The same case tables live in `pwa/tests/unit/api/member-client.test.ts` —
   * the two sanitizer copies are deliberately separate, so mirrored tables are
   * what makes drift between them visible.
   */
  describe("getFamilyMembers payload validation", () => {
    /** Mirrors the literal in `extension/src/api/memberValidation.ts`. */
    const MALFORMED_CONTAINER_WARNING =
      "[memberValidation] malformed members payload: expected an array, treating as empty";

    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** Serve an arbitrary (untyped) payload as the `data` of a 200 envelope. */
    async function fetchGroup(
      data: unknown,
    ): Promise<ApiResponse<FamilyGroup>> {
      globalThis.fetch = mockFetchSuccess(data);
      return client.getFamilyMembers(FAMILY_ID);
    }

    /** The sanitized `data` of a 200 envelope — fails loudly if it went missing. */
    async function sanitizedGroup(data: unknown): Promise<FamilyGroup> {
      const res = await fetchGroup(data);
      if (res.data === undefined) {
        throw new Error("expected a sanitized group in the envelope");
      }
      return res.data;
    }

    /** The sanitized member list for a group whose `members` field is `members`. */
    async function sanitizedMembers(members: unknown): Promise<FamilyMember[]> {
      const group = await sanitizedGroup({ ...makeGroup(), members });
      return group.members;
    }

    /** The single surviving member of a one-element list. */
    async function sanitizedMember(element: unknown): Promise<FamilyMember> {
      const members = await sanitizedMembers([element]);
      expect(members).toHaveLength(1);
      return members[0];
    }

    describe("envelope passthrough", () => {
      it("passes an error envelope through without sanitizing or warning", async () => {
        // An auth failure must never be laundered into an empty member list
        // (Invariant 2) — the caller's own `if (response.error)` has to still
        // see the error it would have seen.
        globalThis.fetch = mockFetchError(
          "FORBIDDEN",
          "Not a member of this family",
          403,
        );

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.error).toEqual({
          code: "FORBIDDEN",
          message: "Not a member of this family",
        });
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps the error verbatim and stands the structural rebuild down when a 200 envelope carries both", async () => {
        // The two layers answer this envelope differently, and both answers
        // matter. Layer 1 (`memberValidation`) stands down entirely, because an
        // auth failure must never be laundered into a member list
        // (Invariant 2). Layer 2 (the shared text layer) has no such rule — it
        // short-circuits on ABSENT data only — so the claimed text fields are
        // still coerced. Neither can turn the failure into a success: `error`
        // reaches the caller's own `if (response.error)` byte-identical.
        globalThis.fetch = mockFetchEnvelope({
          data: { members: 42 },
          error: { code: "STALE_DATA", message: "Rebuild in progress" },
        });

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.error).toEqual({
          code: "STALE_DATA",
          message: "Rebuild in progress",
        });
        // Silence is the proof layer 1 did not run: `members: 42` is exactly
        // what its malformed-container branch warns about, and the text layer's
        // own degradation of that field is deliberately quiet.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(result.data).toStrictEqual({
          familyId: "",
          ownerId: "",
          createdAt: "",
          members: [],
        });
        // Second, independent tell: layer 1 ALWAYS emits `apiEndpoint`, so its
        // absence here says the rebuild was skipped rather than merely quiet.
        expect(asRecord(result.data)).not.toHaveProperty("apiEndpoint");
      });

      it("passes a data-less success envelope through as-is", async () => {
        globalThis.fetch = mockFetchEnvelope({});

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result).toEqual({});
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("passes a null-data envelope through as-is", async () => {
        globalThis.fetch = mockFetchEnvelope({ data: null });

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.data).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("still sanitizes when error is null, because callers read error as truthy", async () => {
        // `if (response.error)` reads `error: null` as success and consumes
        // `data`, so this envelope is exactly the one that must NOT be waved
        // through — while the null itself is preserved for the caller.
        globalThis.fetch = mockFetchEnvelope({
          data: { ...makeGroup(), members: "not-an-array" },
          error: null,
        });

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.error).toBeNull();
        expect(result.data?.members).toEqual([]);
        expect(result.data?.familyId).toBe(FAMILY_ID);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("malformed container", () => {
      const MEMBERS_CASES: Array<{ name: string; members: unknown }> = [
        { name: "missing", members: undefined },
        { name: "null", members: null },
        { name: "a string", members: "[]" },
        { name: "a number", members: 42 },
        { name: "a boolean", members: true },
        { name: "a plain object", members: {} },
        { name: "an object wrapping the list", members: { list: [] } },
      ];

      it.each(MEMBERS_CASES)(
        "returns an empty member list and warns once when members is $name",
        async ({ members }) => {
          const group = await sanitizedGroup({ ...makeGroup(), members });

          expect(group.members).toEqual([]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[memberValidation]"),
          );
        },
      );

      it("warns with the exact malformed-container message", async () => {
        await sanitizedGroup({ ...makeGroup(), members: "nope" });

        expect(warnSpy).toHaveBeenCalledWith(MALFORMED_CONTAINER_WARNING);
      });

      const NON_OBJECT_DATA: Array<{ name: string; data: unknown }> = [
        { name: "a string", data: "members" },
        { name: "a number", data: 42 },
        { name: "a boolean", data: true },
        { name: "an empty array", data: [] },
        { name: "an array of members", data: [makeMember()] },
      ];

      it.each(NON_OBJECT_DATA)(
        "materializes an empty family group and warns once when data is $name",
        async ({ data }) => {
          const group = await sanitizedGroup(data);

          // Both layers contribute, and neither invents a claim: layer 1
          // degrades a non-record `data` to a members-only group plus its
          // always-emitted `apiEndpoint`, then layer 2 materializes the three
          // declared-string fields as `""`. A non-object `data` never claimed
          // any of them, so the result is the renderable EMPTY state.
          expect(group).toEqual({
            familyId: "",
            ownerId: "",
            createdAt: "",
            members: [],
            apiEndpoint: null,
          });
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[memberValidation]"),
          );
        },
      );
    });

    describe("element dropping", () => {
      const DROPPED_CASES: Array<{ name: string; element: unknown }> = [
        { name: "null", element: null },
        { name: "undefined", element: undefined },
        { name: "a string primitive", element: USER_A },
        { name: "a number primitive", element: 42 },
        { name: "a boolean primitive", element: true },
        { name: "an array", element: [USER_A] },
        { name: "an array wrapping a member", element: [makeMember()] },
        { name: "an object with no userId", element: withoutField("userId") },
        { name: "an empty-string userId", element: withField("userId", "") },
        { name: "a numeric userId", element: withField("userId", 7) },
        { name: "a null userId", element: withField("userId", null) },
        { name: "a boolean userId", element: withField("userId", true) },
        {
          name: "an object userId",
          element: withField("userId", { id: USER_A }),
        },
        { name: "an array userId", element: withField("userId", [USER_A]) },
      ];

      it.each(DROPPED_CASES)(
        "drops an element that is $name while keeping valid siblings",
        async ({ element }) => {
          const survivor = makeMember({ userId: USER_B });

          const members = await sanitizedMembers([element, survivor]);

          expect(members).toEqual([survivor]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[memberValidation]"),
          );
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("dropped 1"),
          );
        },
      );

      it("preserves the order of the surviving elements around a dropped one", async () => {
        const first = makeMember({ userId: USER_A });
        const last = makeMember({ userId: USER_B });

        const members = await sanitizedMembers([first, null, last]);

        expect(members.map((member) => member.userId)).toEqual([
          USER_A,
          USER_B,
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("field normalization", () => {
      it.each(NON_STRING_VALUES)(
        'normalizes displayName to "" when the backend sends $name',
        async ({ value }) => {
          const member = await sanitizedMember(withField("displayName", value));

          expect(member.displayName).toBe("");
          expect(member.userId).toBe(USER_A);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it('normalizes a missing displayName to ""', async () => {
        const member = await sanitizedMember(withoutField("displayName"));

        expect(member.displayName).toBe("");
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps the displayName string verbatim, including one the backend really sent as empty", async () => {
        const named = makeMember({ userId: USER_A, displayName: "Alice" });
        const unnamed = makeMember({ userId: USER_B, displayName: "" });

        const members = await sanitizedMembers([named, unnamed]);

        expect(members).toEqual([named, unnamed]);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it.each([
        { name: "TRUE", flag: BoolFlag.TRUE },
        { name: "FALSE", flag: BoolFlag.FALSE },
      ])(
        "keeps canLend when it is exactly BoolFlag.$name",
        async ({ flag }) => {
          const member = await sanitizedMember(withField("canLend", flag));

          expect(member.canLend).toBe(flag);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it.each(INVALID_CANLEND)(
        "omits canLend entirely when the backend sends $name",
        async ({ value }) => {
          const member = await sanitizedMember(withField("canLend", value));

          // Omitted, not set to `undefined`: absence is what the documented
          // "missing canLend means TRUE" fallback is written against.
          expect("canLend" in member).toBe(false);
          expect(Object.keys(member)).not.toContain("canLend");
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("omits canLend when the backend does not send it at all", async () => {
        const member = await sanitizedMember(withoutField("canLend"));

        expect("canLend" in member).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it.each([
        { name: "a name", value: "alice@readmoo" },
        { name: "an empty string", value: "" },
      ])(
        "keeps readmooName when the backend sends $name",
        async ({ value }) => {
          const member = await sanitizedMember(withField("readmooName", value));

          expect(member.readmooName).toBe(value);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it.each(NON_STRING_VALUES)(
        "omits readmooName entirely when the backend sends $name",
        async ({ value }) => {
          const member = await sanitizedMember(withField("readmooName", value));

          expect("readmooName" in member).toBe(false);
          expect(Object.keys(member)).not.toContain("readmooName");
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("omits readmooName when the backend does not send it at all", async () => {
        const member = await sanitizedMember(withoutField("readmooName"));

        expect("readmooName" in member).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps a minimal member as exactly userId plus a normalized displayName", async () => {
        const member = await sanitizedMember({ userId: USER_B });

        expect(member).toEqual({ userId: USER_B, displayName: "" });
        expect(Object.keys(member).sort()).toEqual(["displayName", "userId"]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("group field handling", () => {
      it("passes every other FamilyGroup field through verbatim while rebuilding members", async () => {
        // Every text field here is a REAL string, which is the point: the
        // layers coerce TYPES, never content, so a well-formed payload has to
        // come back byte-identical. `apiEndpoint` survives verbatim for the
        // same reason; the `apiEndpoint normalization` suite below owns what
        // happens when it is not a string.
        const group = await sanitizedGroup({
          familyId: FAMILY_ID,
          ownerId: USER_A,
          members: "not-an-array",
          maxMembers: 6,
          createdAt: "2026-04-26T00:00:00Z",
          apiEndpoint: "https://byo.example.com",
          authToken: "token-abc",
          expiresAt: 1234567890,
        });

        expect(group).toEqual({
          familyId: FAMILY_ID,
          ownerId: USER_A,
          members: [],
          maxMembers: 6,
          createdAt: "2026-04-26T00:00:00Z",
          apiEndpoint: "https://byo.example.com",
          authToken: "token-abc",
          expiresAt: 1234567890,
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });

      it("passes unknown top-level fields through verbatim", async () => {
        const group = await sanitizedGroup({
          ...makeGroup(),
          futureField: "x",
          nested: { deep: true },
        });

        expect(asRecord(group).futureField).toBe("x");
        expect(asRecord(group).nested).toEqual({ deep: true });
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("coerces the declared-string fields in the text layer while non-text fields stay unproven claims", async () => {
        // Where the two layers divide. `memberValidation` rebuilds `members`
        // and normalizes `apiEndpoint` and stops there, documenting the rest as
        // out of its scope — but the shared text layer composed after it then
        // hardens every field the `FamilyGroup` interface declares `string`, so
        // `familyId` / `ownerId` / `createdAt` are no longer claims.
        //
        // What NEITHER layer touches stays a claim on purpose: `maxMembers` and
        // `expiresAt` are numbers whose consumers do `===` comparisons and `??`
        // fallbacks that are safe for an arbitrary value, and `authToken` is a
        // credential — degrading it to `""` would hide a broken backend behind
        // a silent re-auth loop instead of the 401 the request already
        // produces.
        const group = await sanitizedGroup({
          familyId: 42,
          ownerId: null,
          createdAt: { at: 0 },
          maxMembers: "six",
          authToken: { token: "abc" },
          expiresAt: "soon",
          members: [makeMember()],
        });

        // Coerced by the text layer.
        expect(asRecord(group).familyId).toBe("");
        expect(asRecord(group).ownerId).toBe("");
        expect(asRecord(group).createdAt).toBe("");
        // Untouched by both layers.
        expect(asRecord(group).maxMembers).toBe("six");
        expect(asRecord(group).authToken).toEqual({ token: "abc" });
        expect(asRecord(group).expiresAt).toBe("soon");
        // Rebuilt by the structural layer; the text layer is a no-op over it.
        expect(group.members).toEqual([makeMember()]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    /**
     * `apiEndpoint` is the one pass-through field that reaches a React child —
     * the transfer-owner confirm screen prints it (`dialog/MemberList.tsx`,
     * `.moo-member-list__endpoint`) — so its declared type has to hold rather
     * than stay a claim: any string survives verbatim, everything else
     * collapses to `null`, which is what `apiEndpoint ?? undefined` already
     * reads as "no custom endpoint". The key is ALWAYS emitted, so a caller
     * never has to distinguish "absent" from "not a string".
     */
    describe("apiEndpoint normalization", () => {
      /** The sanitized `apiEndpoint` of a group claiming `apiEndpoint`. */
      async function sanitizedEndpoint(
        apiEndpoint: unknown,
      ): Promise<string | null | undefined> {
        const group = await sanitizedGroup({ ...makeGroup(), apiEndpoint });
        return group.apiEndpoint;
      }

      const NON_STRING_ENDPOINTS: Array<{ name: string; value: unknown }> = [
        { name: "an object", value: { url: "https://byo.example.com" } },
        { name: "an array", value: ["https://byo.example.com"] },
        { name: "a number", value: 42 },
        { name: "the boolean true", value: true },
        { name: "null", value: null },
        { name: "undefined", value: undefined },
      ];

      it.each(NON_STRING_ENDPOINTS)(
        "collapses apiEndpoint to null when the backend sends $name",
        async ({ value }) => {
          // Silent normalization, not a drop: nothing is lost that the
          // "no custom endpoint" reading did not already cover.
          expect(await sanitizedEndpoint(value)).toBeNull();
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("emits apiEndpoint as null when the backend omits the key entirely", async () => {
        const payload = makeGroup();
        // Precondition: the fixture really does omit the key.
        expect("apiEndpoint" in payload).toBe(false);

        const group = await sanitizedGroup(payload);

        expect("apiEndpoint" in group).toBe(true);
        expect(group.apiEndpoint).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it.each([
        { name: "a custom endpoint URL", value: "https://byo.example.com" },
        { name: "an empty string", value: "" },
      ])(
        "keeps the apiEndpoint string verbatim when the backend sends $name",
        async ({ value }) => {
          expect(await sanitizedEndpoint(value)).toBe(value);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("does not let a normalized apiEndpoint inflate the dropped-member count", async () => {
        // The two failure modes stay distinct: normalizing a field warns
        // nothing, and only the dropped element is reported.
        const survivor = makeMember({ userId: USER_B });

        const group = await sanitizedGroup({
          ...makeGroup(),
          members: [null, survivor],
          apiEndpoint: { url: "https://byo.example.com" },
        });

        expect(group.apiEndpoint).toBeNull();
        expect(group.members).toEqual([survivor]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 1"),
        );
      });
    });

    describe("result object shape", () => {
      it("rebuilds each member as a fresh object carrying at most the 4 FamilyMember keys", async () => {
        const element = {
          ...makeMember(),
          evil: "x",
          nested: { deep: true },
        };

        const member = await sanitizedMember(element);

        expect(Object.keys(member).sort()).toEqual(SORTED_MEMBER_KEYS);
        expect(asRecord(member).evil).toBeUndefined();
        expect(member).not.toBe(element);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("drops a JSON-supplied __proto__ property instead of carrying or applying it", async () => {
        // Only `JSON.parse` can produce an OWN "__proto__" key (an object
        // literal would set the prototype instead) — which is exactly what a
        // real `response.json()` does with a hostile body.
        const hostile: unknown = JSON.parse(
          `{"members":[{"userId":"${USER_B}","displayName":"Hostile","__proto__":{"polluted":"yes"},"evil":"x"}]}`,
        );

        const group = await sanitizedGroup(hostile);

        const member = group.members[0];
        expect(Object.keys(member).sort()).toEqual(["displayName", "userId"]);
        expect(Object.getPrototypeOf(member)).toBe(Object.prototype);
        expect(asRecord(member).evil).toBeUndefined();
        expect(asRecord({}).polluted).toBeUndefined();
        expect(member.userId).toBe(USER_B);
        expect(member.displayName).toBe("Hostile");
      });

      it("does not apply a JSON-supplied top-level __proto__ to the rebuilt group", async () => {
        const hostile: unknown = JSON.parse(
          '{"members":[],"__proto__":{"polluted":"yes"}}',
        );

        const group = await sanitizedGroup(hostile);

        expect(Object.getPrototypeOf(group)).toBe(Object.prototype);
        expect(asRecord({}).polluted).toBeUndefined();
        expect(group.members).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("returns a new group object and leaves the parsed payload unmutated", async () => {
        const payload = { ...makeGroup(), members: [withField("evil", "x")] };

        const res = await fetchGroup(payload);

        expect(res.data).not.toBe(payload);
        expect(res.data?.members).not.toBe(payload.members);
        expect(asRecord(payload.members[0]).evil).toBe("x");
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("aggregate warning", () => {
      it("emits exactly one warning naming the dropped count, not one per element", async () => {
        const survivor = makeMember({ userId: USER_B });

        const members = await sanitizedMembers([
          null,
          "nope",
          { userId: "" },
          survivor,
        ]);

        expect(members).toEqual([survivor]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 3"),
        );
      });

      it("warns with the exact dropped-count message", async () => {
        await sanitizedMembers([null, 42, makeMember()]);

        expect(warnSpy).toHaveBeenCalledWith(
          "[memberValidation] dropped 2 malformed family member(s)",
        );
      });

      it("counts only dropped elements, never normalized ones", async () => {
        // A normalized element is KEPT, so it must not inflate the count that
        // the warning reports — the two failure modes stay distinct.
        const members = await sanitizedMembers([
          withField("displayName", 42),
          withField("canLend", "1"),
          null,
        ]);

        expect(members).toHaveLength(2);
        expect(members[0].displayName).toBe("");
        expect("canLend" in members[1]).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 1"),
        );
      });

      it("returns an empty list with a single warning when every element is malformed", async () => {
        const members = await sanitizedMembers([null, 42, { userId: "" }]);

        expect(members).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 3"),
        );
      });

      it("emits no warning for a fully valid payload", async () => {
        const list = [
          makeMember({ userId: USER_A }),
          makeMember({ userId: USER_B, canLend: BoolFlag.FALSE }),
        ];

        const members = await sanitizedMembers(list);

        expect(members).toEqual(list);
        expect(members[0]).not.toBe(list[0]);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("emits no warning for an empty member list", async () => {
        const members = await sanitizedMembers([]);

        expect(members).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * Runtime boundary validation of the single-member `PATCH
 * /api/family/:id/member/:uid` payload.
 *
 * The criteria are the SAME `sanitizeFamilyMember` drop/normalize rules the list
 * suite above pins — one function, one contract — but the verdict for a payload
 * that has to be dropped differs: an unusable element of a list is skipped
 * silently, while an unusable PATCH response becomes an `ApiError`. It has to be
 * one: `updateMember` in `dialog/FamilyDataContext.tsx` splices this object
 * straight into `members` state, so "skip it" is not an available outcome, and
 * all three call sites (`dialog/BorrowTab.tsx`'s picker write-back,
 * `dialog/MemberList.tsx`'s canLend toggle and readmooName delete) already catch
 * and route through `memberSettingsErrorMessage`.
 *
 * Driven through the public `updateMemberSettings` surface instead of importing
 * the sanitizer: the contract is what a caller receives when a self-hosted (BYO)
 * or hostile backend answers. Request-body wiring for the three settings
 * combinations lives in `extension/tests/unit/api/borrow-client.test.ts`.
 */
describe("ApiClient updateMemberSettings", () => {
  /** The PATCH target — the member whose settings are being written. */
  const TARGET_UID = USER_A;
  const SETTINGS: MemberSettingsPayload = { canLend: BoolFlag.FALSE };

  let client: ApiClient;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new ApiClient(MOCK_ENDPOINT);
    client.setAuthToken("test-token");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  /** Issue the PATCH against whatever fetch mock is currently installed. */
  function sendPatch(): Promise<FamilyMember> {
    return client.updateMemberSettings(FAMILY_ID, TARGET_UID, SETTINGS);
  }

  /** Serve an arbitrary (untyped) payload as the `data` of a 200 envelope. */
  function patchMember(data: unknown): Promise<FamilyMember> {
    globalThis.fetch = mockFetchSuccess(data);
    return sendPatch();
  }

  /** The `ApiError` the PATCH threw — fails loudly when it resolved instead. */
  async function rejectedRequest(): Promise<ApiError> {
    const err = await captureRejection(sendPatch());
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }

  /** The `ApiError` thrown for a payload served as the `data` of a 200. */
  function rejectedPayload(data: unknown): Promise<ApiError> {
    globalThis.fetch = mockFetchSuccess(data);
    return rejectedRequest();
  }

  describe("request wiring", () => {
    it("sends PATCH to /api/family/:id/member/:uid with the settings body and returns the sanitized member", async () => {
      const member = makeMember({ canLend: BoolFlag.FALSE });

      const result = await patchMember(member);

      expect(result).toEqual(member);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(
        `${MOCK_ENDPOINT}/api/family/${FAMILY_ID}/member/${TARGET_UID}`,
      );
      expect(call[1].method).toBe("PATCH");
      expect(JSON.parse(call[1].body as string)).toEqual(SETTINGS);
      expect(call[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      );
    });
  });

  describe("valid payload", () => {
    it("resolves with a member carrying exactly the 4 FamilyMember keys", async () => {
      const result = await patchMember(makeMember());

      expect(result).toEqual(makeMember());
      expect(Object.keys(result).sort()).toEqual(SORTED_MEMBER_KEYS);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("resolves with userId plus a normalized displayName for the most minimal member a backend can send", async () => {
      const result = await patchMember({ userId: USER_B });

      expect(result).toEqual({ userId: USER_B, displayName: "" });
      expect(Object.keys(result).sort()).toEqual(["displayName", "userId"]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("unusable payload", () => {
    const DROPPED_CASES: Array<{ name: string; data: unknown }> = [
      { name: "null", data: null },
      { name: "a string primitive", data: USER_A },
      { name: "an empty string", data: "" },
      { name: "a number primitive", data: 42 },
      { name: "the number zero", data: 0 },
      { name: "a boolean primitive", data: true },
      { name: "an array wrapping the member", data: [makeMember()] },
      { name: "an empty array", data: [] },
      { name: "an empty object", data: {} },
      { name: "an object with no userId", data: withoutField("userId") },
      { name: "an empty-string userId", data: withField("userId", "") },
      { name: "a numeric userId", data: withField("userId", 7) },
      { name: "a null userId", data: withField("userId", null) },
      { name: "a boolean userId", data: withField("userId", true) },
      { name: "an object userId", data: withField("userId", { id: USER_A }) },
      { name: "an array userId", data: withField("userId", [USER_A]) },
    ];

    it.each(DROPPED_CASES)(
      "rejects with INVALID_RESPONSE when the backend answers with $name",
      async ({ data }) => {
        const err = await rejectedPayload(data);

        expect(err.code).toBe("INVALID_RESPONSE");
      },
    );

    it("throws an ApiError whose code, wording and provenance the UI can act on", async () => {
      const err = await rejectedPayload({ displayName: "no id" });

      expect(err.code).toBe("INVALID_RESPONSE");
      expect(err.rawMessage).toBe("response is not a valid family member");
      // The legacy "CODE: text" shape stays intact for existing callers.
      expect(err.message).toBe(
        "INVALID_RESPONSE: response is not a valid family member",
      );
      // No wait to offer: this is not a throttle, and the back-off copy in
      // `memberSettingsErrorMessage` must not fire for it.
      expect(err.retryAfter).toBeUndefined();
      // `synthesized` is the authority that lets a rawMessage be painted into
      // the dialog verbatim; this English developer text must never claim it.
      expect(err.synthesized).toBe(false);
    });

    it("stays silent rather than warning, because the aggregate log line belongs to the list path", async () => {
      await rejectedPayload(null);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("field normalization", () => {
    it.each(NON_STRING_VALUES)(
      'normalizes displayName to "" when the backend sends $name',
      async ({ value }) => {
        const result = await patchMember(withField("displayName", value));

        expect(result.displayName).toBe("");
        expect(result.userId).toBe(USER_A);
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it('normalizes a missing displayName to ""', async () => {
      const result = await patchMember(withoutField("displayName"));

      expect(result.displayName).toBe("");
    });

    it.each([
      { name: "a name", value: "Alice" },
      { name: "an empty string", value: "" },
    ])(
      "keeps the displayName string verbatim when the backend sends $name",
      async ({ value }) => {
        const result = await patchMember(withField("displayName", value));

        expect(result.displayName).toBe(value);
      },
    );

    it.each([
      { name: "TRUE", flag: BoolFlag.TRUE },
      { name: "FALSE", flag: BoolFlag.FALSE },
    ])("keeps canLend when it is exactly BoolFlag.$name", async ({ flag }) => {
      const result = await patchMember(withField("canLend", flag));

      expect(result.canLend).toBe(flag);
    });

    it.each(INVALID_CANLEND)(
      "omits canLend entirely when the backend sends $name",
      async ({ value }) => {
        const result = await patchMember(withField("canLend", value));

        // Omitted, not set to `undefined`: this object is spliced into
        // `members` state as-is, and absence is what the documented "missing
        // canLend means TRUE" fallback is written against.
        expect("canLend" in result).toBe(false);
        expect(Object.keys(result)).not.toContain("canLend");
      },
    );

    it("omits canLend when the backend does not send it at all", async () => {
      const result = await patchMember(withoutField("canLend"));

      expect("canLend" in result).toBe(false);
    });

    it.each([
      { name: "a name", value: "alice@readmoo" },
      { name: "an empty string", value: "" },
    ])("keeps readmooName when the backend sends $name", async ({ value }) => {
      const result = await patchMember(withField("readmooName", value));

      expect(result.readmooName).toBe(value);
    });

    it.each(NON_STRING_VALUES)(
      "omits readmooName entirely when the backend sends $name",
      async ({ value }) => {
        const result = await patchMember(withField("readmooName", value));

        expect("readmooName" in result).toBe(false);
        expect(Object.keys(result)).not.toContain("readmooName");
      },
    );

    it("omits readmooName when the backend does not send it at all", async () => {
      // The readmooName-delete flow in `dialog/MemberList.tsx` PATCHes `null`
      // and gets a member without the field back — the "尚未記錄" hint reads
      // absence, so it must survive the rebuild as absence.
      const result = await patchMember(withoutField("readmooName"));

      expect("readmooName" in result).toBe(false);
    });
  });

  describe("result object shape", () => {
    it("rebuilds the member as a fresh object carrying at most the 4 FamilyMember keys", async () => {
      const payload = { ...makeMember(), evil: "x", nested: { deep: true } };

      const result = await patchMember(payload);

      expect(Object.keys(result).sort()).toEqual(SORTED_MEMBER_KEYS);
      expect(asRecord(result).evil).toBeUndefined();
      expect(asRecord(result).nested).toBeUndefined();
      expect(result).not.toBe(payload);
    });

    it("drops a JSON-supplied __proto__ property instead of carrying or applying it", async () => {
      // Only `JSON.parse` can produce an OWN "__proto__" key (an object literal
      // would set the prototype instead) — which is exactly what a real
      // `response.json()` does with a hostile body.
      const hostile: unknown = JSON.parse(
        `{"userId":"${USER_B}","displayName":"Hostile","__proto__":{"polluted":"yes"},"evil":"x"}`,
      );

      const result = await patchMember(hostile);

      expect(Object.keys(result).sort()).toEqual(["displayName", "userId"]);
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(asRecord(result).evil).toBeUndefined();
      expect(asRecord({}).polluted).toBeUndefined();
      expect(result.userId).toBe(USER_B);
      expect(result.displayName).toBe("Hostile");
    });

    it("leaves the parsed payload unmutated", async () => {
      const payload = withField("evil", "x");

      const result = await patchMember(payload);

      expect(result).not.toBe(payload);
      expect(payload.evil).toBe("x");
    });
  });

  describe("envelope contract", () => {
    it("rejects with the envelope's own code, never INVALID_RESPONSE, when the backend refuses", async () => {
      // A 403 must never be laundered into "malformed response": the two send
      // the user to completely different remedies.
      globalThis.fetch = mockFetchError(
        "FORBIDDEN",
        "Cannot modify another member",
        403,
      );

      const err = await rejectedRequest();

      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("FORBIDDEN: Cannot modify another member");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("preserves retryAfter from a rate-limited envelope", async () => {
      // The localized back-off copy needs both the code and the wait; the
      // INVALID_RESPONSE throw carries neither, so the two stay distinguishable.
      globalThis.fetch = mockFetchEnvelope(
        {
          error: {
            code: "RATE_LIMITED",
            message: "too many requests",
            retryAfter: 45,
          },
        },
        429,
      );

      const err = await rejectedRequest();

      expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfter: 45 });
    });

    it("rejects with NETWORK_ERROR when fetch itself rejects", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Failed to fetch"));

      const err = await rejectedRequest();

      expect(err.code).toBe("NETWORK_ERROR");
    });

    it.each([
      { name: "carries no data key at all", envelope: {} },
      { name: "sets data to undefined", envelope: { data: undefined } },
    ])(
      "rejects with EMPTY_RESPONSE when a success envelope $name",
      async ({ envelope }) => {
        // `unwrap` still owns the envelope contract and runs BEFORE the
        // sanitizer: a missing `data` is a protocol failure, not a member
        // object that failed validation.
        globalThis.fetch = mockFetchEnvelope(envelope);

        const err = await rejectedRequest();

        expect(err.code).toBe("EMPTY_RESPONSE");
        expect(err.message).toBe("EMPTY_RESPONSE: response body missing data");
      },
    );

    it("rejects with INVALID_RESPONSE, not EMPTY_RESPONSE, when data is explicitly null", async () => {
      // `unwrap` only refuses `undefined`, so a null `data` does reach the
      // sanitizer — the two failure modes stay distinct for the caller.
      const err = await rejectedPayload(null);

      expect(err.code).toBe("INVALID_RESPONSE");
    });

    it.each([
      { name: "a valid member", data: makeMember() },
      { name: "an unusable member", data: { displayName: "no id" } },
    ])(
      "throws the envelope error before sanitizing when a 200 carries an error alongside $name",
      async ({ data }) => {
        globalThis.fetch = mockFetchEnvelope({
          data,
          error: { code: "STALE_DATA", message: "Rebuild in progress" },
        });

        const err = await rejectedRequest();

        expect(err.code).toBe("STALE_DATA");
      },
    );

    it("still validates the payload when error is null, because unwrap reads error as truthy", async () => {
      globalThis.fetch = mockFetchEnvelope({
        data: { displayName: "no id" },
        error: null,
      });

      const err = await rejectedRequest();

      expect(err.code).toBe("INVALID_RESPONSE");
    });

    it("resolves normally when a valid payload arrives alongside error null", async () => {
      globalThis.fetch = mockFetchEnvelope({
        data: makeMember(),
        error: null,
      });

      await expect(sendPatch()).resolves.toEqual(makeMember());
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
