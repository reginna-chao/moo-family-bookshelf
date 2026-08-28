import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// `@/api/client` is imported FIRST on purpose. The PWA copy of
// `memberValidation` reads the `BoolFlag` VALUE back out of `./client`, so the
// two form a real runtime import cycle, and the entry point decides which body
// runs first: entering from `client` makes ESM evaluate `memberValidation`'s
// body BEFORE `client`'s own body initialises the enum — the order in which a
// module-level `BoolFlag` read would actually throw, and the app's own order,
// since no production module imports `memberValidation` directly. Entering from
// `memberValidation` instead would evaluate `client` first and hide exactly
// that regression. See the direct-import suite at the bottom.
import {
  ApiClient,
  BoolFlag,
  type ApiResponse,
  type FamilyGroup,
  type FamilyMember,
} from "@/api/client";
import { sanitizeFamilyMembersResponse } from "@/api/memberValidation";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT = "https://api.example.com";
const FAMILY_ID = "fam-abc";
const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
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

describe("ApiClient getFamilyMembers (PWA)", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient(ENDPOINT);
    client.setAuthToken("test-token");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request wiring", () => {
    it("sends GET to /api/family/:id/members and returns the group envelope", async () => {
      const group = makeGroup();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: group }));

      const result = await client.getFamilyMembers(FAMILY_ID);

      // The group comes back as sent, plus the `apiEndpoint` the sanitizer
      // always emits — `null` here because the fixture omits the key. The
      // normalization itself is covered in its own suite below.
      expect(result.data).toEqual({ ...group, apiEndpoint: null });
      expect(result.error).toBeUndefined();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/members`);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init.headers["Authorization"]).toBe("Bearer test-token");
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
   * The same case tables live in
   * `extension/tests/unit/api/member-client.test.ts` — the two sanitizer copies
   * are deliberately separate, so mirrored tables are what makes drift between
   * them visible.
   */
  describe("getFamilyMembers payload validation", () => {
    /** Exactly the keys `FamilyMember` declares — the sanitized element's key set. */
    const MEMBER_KEYS = ["userId", "displayName", "canLend", "readmooName"];
    const SORTED_MEMBER_KEYS = [...MEMBER_KEYS].sort();

    /** Mirrors the literal in `pwa/src/api/memberValidation.ts`. */
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
      mockFetch.mockResolvedValueOnce(jsonResponse({ data }));
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

    describe("envelope passthrough", () => {
      it("passes an error envelope through without sanitizing or warning", async () => {
        // An auth failure must never be laundered into an empty member list
        // (Invariant 2) — the caller's own `if (response.error)` has to still
        // see the error it would have seen.
        mockFetch.mockResolvedValueOnce(
          jsonResponse(
            {
              error: {
                code: "FORBIDDEN",
                message: "Not a member of this family",
              },
            },
            403,
          ),
        );

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.error).toEqual({
          code: "FORBIDDEN",
          message: "Not a member of this family",
        });
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("leaves data untouched when a 200 envelope carries an error alongside it", async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: { members: 42 },
            error: { code: "STALE_DATA", message: "Rebuild in progress" },
          }),
        );

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.error).toEqual({
          code: "STALE_DATA",
          message: "Rebuild in progress",
        });
        expect(asRecord(result.data).members).toBe(42);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("passes a data-less success envelope through as-is", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({}));

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result).toEqual({});
        expect(result.data).toBeUndefined();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("passes a null-data envelope through as-is", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));

        const result = await client.getFamilyMembers(FAMILY_ID);

        expect(result.data).toBeNull();
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("still sanitizes when error is null, because callers read error as truthy", async () => {
        // `if (response.error)` reads `error: null` as success and consumes
        // `data`, so this envelope is exactly the one that must NOT be waved
        // through — while the null itself is preserved for the caller.
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: { ...makeGroup(), members: "not-an-array" },
            error: null,
          }),
        );

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
        "degrades to a members-only group and warns once when data is $name",
        async ({ data }) => {
          const group = await sanitizedGroup(data);

          // A members-only group still carries the always-emitted
          // `apiEndpoint`, which a non-object `data` can never have claimed.
          expect(group).toEqual({ members: [], apiEndpoint: null });
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

    describe("group field passthrough", () => {
      it("passes every other FamilyGroup field through verbatim while rebuilding members", async () => {
        // `apiEndpoint` is a string here, so it survives verbatim like the
        // rest; it is the ONE field that is not a raw passthrough, and the
        // `apiEndpoint normalization` suite below owns that behavior.
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

      it("leaves the other top-level fields unvalidated, sanitizing only members", async () => {
        // Those fields are unproven claims by design: their consumers do `===`
        // comparisons and `??` fallbacks that are safe for an arbitrary value.
        const group = await sanitizedGroup({
          familyId: 42,
          ownerId: null,
          maxMembers: "six",
          createdAt: { at: 0 },
          members: [makeMember()],
        });

        expect(asRecord(group).familyId).toBe(42);
        expect(asRecord(group).ownerId).toBeNull();
        expect(asRecord(group).maxMembers).toBe("six");
        expect(asRecord(group).createdAt).toEqual({ at: 0 });
        expect(group.members).toEqual([makeMember()]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    /**
     * `apiEndpoint` is the one pass-through field that reaches a React child —
     * the Extension's transfer-owner confirm screen prints it verbatim, and
     * this end publishes the same value through `hooks/useFamilyData.tsx` for
     * any screen to render — so its declared type has to hold rather than stay
     * a claim: any string survives verbatim, everything else collapses to
     * `null`, which is what `apiEndpoint ?? undefined` already reads as "no
     * custom endpoint". The key is ALWAYS emitted, so a caller never has to
     * distinguish "absent" from "not a string".
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
 * Import-cycle smoke test, PWA-only.
 *
 * `pwa/src/api/memberValidation.ts` imports the `BoolFlag` VALUE from
 * `./client`, which imports `sanitizeFamilyMembersResponse` back — a cycle that
 * survives compilation (the extension copy reads `BoolFlag` from `./types`
 * instead and has none). Production argues it is safe because both sides touch
 * each other only inside function bodies.
 *
 * This file enters that cycle from `@/api/client` (see the import order at the
 * top) — the app's own order, since no production module imports
 * `memberValidation` directly, and the strictest one: ESM evaluates
 * `memberValidation`'s body BEFORE `client` initialises `BoolFlag`, so a future
 * refactor that hoists either access to module-evaluation time fails here
 * instead of at runtime. This suite then calls the export directly, proving the
 * binding resolved through the cycle rather than only via the client method.
 */
describe("sanitizeFamilyMembersResponse (direct import)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("resolves the BoolFlag comparisons when the cycle is entered from the client module", () => {
    const res: ApiResponse<unknown> = {
      data: {
        familyId: FAMILY_ID,
        members: [
          { userId: USER_A, displayName: "Alice", canLend: BoolFlag.FALSE },
          { userId: USER_B, displayName: "Bob", canLend: true },
          "not-a-member",
        ],
      },
    };

    const result = sanitizeFamilyMembersResponse(res);

    // A kept `BoolFlag.FALSE` proves the enum binding was initialised: an
    // uninitialised one would throw, and a wrong one would drop the field.
    expect(result.data?.members).toEqual([
      { userId: USER_A, displayName: "Alice", canLend: BoolFlag.FALSE },
      { userId: USER_B, displayName: "Bob" },
    ]);
    expect(result.data?.familyId).toBe(FAMILY_ID);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1"));
  });

  it("passes an error envelope through untouched", () => {
    const res: ApiResponse<unknown> = {
      data: { members: 42 },
      error: { code: "FORBIDDEN", message: "Not a member of this family" },
    };

    const result = sanitizeFamilyMembersResponse(res);

    expect(result).toBe(res);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
