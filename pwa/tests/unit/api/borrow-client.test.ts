import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApiClient,
  BoolFlag,
  BorrowStatus,
  type BorrowRequest,
  type CreateBorrowPayload,
  type FamilyMember,
} from "@/api/client";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const ENDPOINT = "https://api.example.com";
const FAMILY_ID = "fam-abc";
const REQUEST_ID = "req-123";
const OWNER_ID = "a".repeat(64);
const BORROWER_ID = "b".repeat(64);

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  };
}

function makeBorrowRequest(
  overrides: Partial<BorrowRequest> = {},
): BorrowRequest {
  return {
    requestId: REQUEST_ID,
    familyId: FAMILY_ID,
    borrowerId: BORROWER_ID,
    borrowerName: "Bob",
    ownerId: OWNER_ID,
    bookId: "book-1",
    bookTitle: "The Test Book",
    bookAuthor: "Author A",
    bookCoverUrl: "https://example.com/cover.jpg",
    status: BorrowStatus.PENDING,
    createdAt: "2026-04-26T00:00:00Z",
    updatedAt: "2026-04-26T00:00:00Z",
    ...overrides,
  };
}

describe("ApiClient borrow methods (PWA)", () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient(ENDPOINT);
    client.setAuthToken("test-token");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("createBorrowRequest", () => {
    const payload: CreateBorrowPayload = {
      bookId: "book-1",
      bookTitle: "The Test Book",
      bookAuthor: "Author A",
      bookCoverUrl: "https://example.com/cover.jpg",
      ownerId: OWNER_ID,
    };

    it("sends POST to /api/family/:id/borrow with payload and returns unwrapped data", async () => {
      const expected = makeBorrowRequest();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: expected }));

      const result = await client.createBorrowRequest(FAMILY_ID, payload);

      expect(result).toEqual(expected);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/borrow`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(payload);
      expect(init.headers["Authorization"]).toBe("Bearer test-token");
    });

    it("throws with formatted message on error envelope (DUPLICATE_REQUEST)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "DUPLICATE_REQUEST",
              message: "Active request already exists for this book",
            },
          },
          409,
        ),
      );

      await expect(
        client.createBorrowRequest(FAMILY_ID, payload),
      ).rejects.toThrow(
        "DUPLICATE_REQUEST: Active request already exists for this book",
      );
    });
  });

  describe("listBorrowRequests", () => {
    it("sends GET to /api/family/:id/borrow and returns the array", async () => {
      const list = [
        makeBorrowRequest(),
        makeBorrowRequest({ requestId: "req-456", status: BorrowStatus.LENT }),
      ];
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: list }));

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result).toEqual(list);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/borrow`);
      expect(init?.method ?? "GET").toBe("GET");
    });

    it("returns empty array when API returns []", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result).toEqual([]);
    });

    it("throws with formatted message on error envelope", async () => {
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

      await expect(client.listBorrowRequests(FAMILY_ID)).rejects.toThrow(
        "FORBIDDEN: Not a member of this family",
      );
    });
  });

  /**
   * Runtime boundary validation of the borrow-list payload.
   *
   * Driven through the public `listBorrowRequests` surface instead of importing
   * `sanitizeBorrowRequests` directly: the contract is what a caller receives
   * when a self-hosted (BYO) or hostile backend answers, not the shape of the
   * helper. The same case tables live in
   * `extension/tests/unit/api/borrow-client.test.ts` — the sanitizer itself is
   * the shared implementation in `shared/src/borrow/validation.ts` that both
   * apps import, so the mirrored tables no longer guard two copies against each
   * other; they prove each app's own client still wires that implementation in.
   */
  describe("listBorrowRequests payload validation", () => {
    /** Exactly the keys `BorrowRequest` declares — the sanitized result's key set. */
    const BORROW_REQUEST_KEYS = [
      "requestId",
      "familyId",
      "borrowerId",
      "borrowerName",
      "ownerId",
      "bookId",
      "bookTitle",
      "bookAuthor",
      "bookCoverUrl",
      "status",
      "createdAt",
      "updatedAt",
    ];
    const SORTED_KEYS = [...BORROW_REQUEST_KEYS].sort();

    /** The 10 string fields normalized to `""`; a bad `requestId` drops instead. */
    const NORMALIZED_STRING_FIELDS = [
      "familyId",
      "borrowerId",
      "borrowerName",
      "ownerId",
      "bookId",
      "bookTitle",
      "bookAuthor",
      "bookCoverUrl",
      "createdAt",
      "updatedAt",
    ];

    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    /** Serve an arbitrary (untyped) payload as the `data` of a 200 envelope. */
    async function listPayload(payload: unknown): Promise<BorrowRequest[]> {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: payload }));
      return client.listBorrowRequests(FAMILY_ID);
    }

    /** Read a value as a bag of unknowns — the tables feed fields the type forbids. */
    function asRecord(value: unknown): Record<string, unknown> {
      return value as Record<string, unknown>;
    }

    /** A valid element with one field replaced by an untrusted value. */
    function withField(field: string, value: unknown): Record<string, unknown> {
      return { ...makeBorrowRequest(), [field]: value };
    }

    /** A valid element with one field absent entirely. */
    function withoutField(field: string): Record<string, unknown> {
      return Object.fromEntries(
        Object.entries(makeBorrowRequest()).filter(([key]) => key !== field),
      );
    }

    describe("malformed container", () => {
      const CONTAINER_CASES: Array<{ name: string; payload: unknown }> = [
        { name: "null", payload: null },
        { name: "a plain object", payload: {} },
        { name: "an object wrapping the list", payload: { requests: [] } },
        { name: "a string", payload: "[]" },
        { name: "a number", payload: 42 },
        { name: "a boolean", payload: true },
      ];

      it.each(CONTAINER_CASES)(
        "returns an empty list and warns once when data is $name",
        async ({ payload }) => {
          const result = await listPayload(payload);

          expect(result).toEqual([]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[borrowValidation]"),
          );
        },
      );

      it("throws EMPTY_RESPONSE without sanitizing when the envelope carries no data", async () => {
        // `unwrap` still owns the envelope contract and runs BEFORE the
        // sanitizer: a missing `data` is a protocol failure, not a malformed
        // payload that degrades to an empty list.
        mockFetch.mockResolvedValueOnce(jsonResponse({}));

        await expect(client.listBorrowRequests(FAMILY_ID)).rejects.toThrow(
          "EMPTY_RESPONSE: response body missing data",
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("neither sanitizes nor warns when the envelope carries an error", async () => {
        // The error branch of `unwrap` still throws first, so a rejected call
        // must not degrade into an empty list nor emit a validation warning.
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

        await expect(client.listBorrowRequests(FAMILY_ID)).rejects.toThrow(
          "FORBIDDEN: Not a member of this family",
        );
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("element dropping", () => {
      const DROPPED_CASES: Array<{ name: string; element: unknown }> = [
        { name: "null", element: null },
        { name: "undefined", element: undefined },
        { name: "a string primitive", element: "req-123" },
        { name: "a number primitive", element: 42 },
        { name: "a boolean primitive", element: true },
        { name: "an array", element: ["req-123"] },
        {
          name: "an object with no requestId",
          element: withoutField("requestId"),
        },
        {
          name: "an empty-string requestId",
          element: withField("requestId", ""),
        },
        { name: "a numeric requestId", element: withField("requestId", 7) },
        { name: "a null requestId", element: withField("requestId", null) },
        {
          name: "an object requestId",
          element: withField("requestId", { id: "req-123" }),
        },
      ];

      it.each(DROPPED_CASES)(
        "drops an element that is $name while keeping valid siblings",
        async ({ element }) => {
          const survivor = makeBorrowRequest({ requestId: "req-survivor" });

          const result = await listPayload([element, survivor]);

          expect(result).toEqual([survivor]);
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("[borrowValidation]"),
          );
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("dropped 1"),
          );
        },
      );

      it("preserves the order of the surviving elements around a dropped one", async () => {
        const first = makeBorrowRequest({ requestId: "req-first" });
        const last = makeBorrowRequest({ requestId: "req-last" });

        const result = await listPayload([first, null, last]);

        expect(result.map((request) => request.requestId)).toEqual([
          "req-first",
          "req-last",
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("field normalization", () => {
      const NON_STRING_VALUES: Array<{ name: string; value: unknown }> = [
        { name: "a number", value: 42 },
        { name: "null", value: null },
        { name: "undefined", value: undefined },
        { name: "an object", value: { nested: "x" } },
        { name: "an array", value: ["x"] },
        { name: "a boolean", value: false },
      ];

      it.each(NORMALIZED_STRING_FIELDS)(
        "normalizes %s to an empty string when the backend sends a non-string",
        async (field) => {
          const result = await listPayload([withField(field, 42)]);

          const element = asRecord(result[0]);
          const valid = asRecord(makeBorrowRequest());
          expect(element[field]).toBe("");
          // Only the named field is touched; every sibling survives verbatim.
          for (const other of NORMALIZED_STRING_FIELDS) {
            if (other !== field) expect(element[other]).toBe(valid[other]);
          }
          expect(element.requestId).toBe(REQUEST_ID);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it.each(NON_STRING_VALUES)(
        'normalizes every non-requestId string field to "" when it is $name',
        async ({ value }) => {
          const raw: Record<string, unknown> = { ...makeBorrowRequest() };
          for (const field of NORMALIZED_STRING_FIELDS) {
            raw[field] = value;
          }

          const result = await listPayload([raw]);

          const element = asRecord(result[0]);
          for (const field of NORMALIZED_STRING_FIELDS) {
            expect(element[field]).toBe("");
          }
          expect(element.requestId).toBe(REQUEST_ID);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it('normalizes every non-requestId string field to "" when it is missing', async () => {
        const result = await listPayload([
          { requestId: REQUEST_ID, status: BorrowStatus.PENDING },
        ]);

        const element = asRecord(result[0]);
        for (const field of NORMALIZED_STRING_FIELDS) {
          expect(element[field]).toBe("");
        }
        expect(element.requestId).toBe(REQUEST_ID);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("keeps string fields verbatim, including an empty string the backend really sent", async () => {
        const sent = makeBorrowRequest({
          bookAuthor: "",
          bookCoverUrl: "https://example.com/other.jpg",
        });

        const result = await listPayload([sent]);

        expect(result).toEqual([sent]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("status passthrough", () => {
      // `status` is deliberately NOT validated here — unknown-status handling
      // belongs to the render side (PR #132).
      const STATUS_CASES: Array<{ name: string; status: unknown }> = [
        { name: "an unknown numeric status", status: 99 },
        { name: "a negative status", status: -1 },
        { name: "a status-name string", status: "LENT" },
        { name: "the string __proto__", status: "__proto__" },
        { name: "null", status: null },
        { name: "a boolean", status: true },
        { name: "an object", status: { code: 1 } },
      ];

      it.each(STATUS_CASES)(
        "passes $name through unvalidated",
        async ({ status }) => {
          const result = await listPayload([withField("status", status)]);

          expect(result).toHaveLength(1);
          expect(asRecord(result[0]).status).toBe(status);
          expect(warnSpy).not.toHaveBeenCalled();
        },
      );

      it("leaves status undefined when the field is missing, without dropping the element", async () => {
        const result = await listPayload([withoutField("status")]);

        expect(result).toHaveLength(1);
        expect(asRecord(result[0]).status).toBeUndefined();
        expect(Object.keys(result[0]).sort()).toEqual(SORTED_KEYS);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("preserves a valid enum status", async () => {
        const sent = makeBorrowRequest({ status: BorrowStatus.RETURNED });

        const result = await listPayload([sent]);

        expect(result[0].status).toBe(BorrowStatus.RETURNED);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    describe("result object shape", () => {
      it("returns a fresh object carrying exactly the 12 BorrowRequest keys", async () => {
        const element = {
          ...makeBorrowRequest(),
          evil: "x",
          nested: { deep: true },
        };

        const result = await listPayload([element]);

        expect(Object.keys(result[0]).sort()).toEqual(SORTED_KEYS);
        expect(asRecord(result[0]).evil).toBeUndefined();
        expect(result[0]).not.toBe(element);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("drops a JSON-supplied __proto__ property instead of carrying or applying it", async () => {
        // Only `JSON.parse` can produce an OWN "__proto__" key (an object
        // literal would set the prototype instead) — which is exactly what a
        // real `response.json()` does with a hostile body.
        const hostile: unknown = JSON.parse(
          '{"requestId":"req-hostile","bookTitle":"Hostile","__proto__":{"polluted":"yes"},"evil":"x"}',
        );

        const result = await listPayload([hostile]);

        const element = result[0];
        expect(Object.keys(element).sort()).toEqual(SORTED_KEYS);
        expect(Object.getPrototypeOf(element)).toBe(Object.prototype);
        expect(asRecord(element).evil).toBeUndefined();
        expect(asRecord({}).polluted).toBeUndefined();
        expect(element.bookTitle).toBe("Hostile");
        expect(element.createdAt).toBe("");
      });
    });

    describe("aggregate warning", () => {
      it("emits exactly one warning naming the dropped count, not one per element", async () => {
        const survivor = makeBorrowRequest({ requestId: "req-survivor" });

        const result = await listPayload([
          null,
          "nope",
          { requestId: "" },
          survivor,
        ]);

        expect(result).toEqual([survivor]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 3"),
        );
      });

      it("counts only dropped elements, never normalized ones", async () => {
        // A normalized element is KEPT, so it must not inflate the count that
        // the warning reports — the two failure modes stay distinct.
        const result = await listPayload([withField("createdAt", 42), null]);

        expect(result).toHaveLength(1);
        expect(result[0].createdAt).toBe("");
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 1"),
        );
      });

      it("returns an empty list with a single warning when every element is malformed", async () => {
        const result = await listPayload([null, 42, { requestId: "" }]);

        expect(result).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("dropped 3"),
        );
      });

      it("emits no warning for a fully valid payload", async () => {
        const list = [
          makeBorrowRequest(),
          makeBorrowRequest({
            requestId: "req-456",
            status: BorrowStatus.LENT,
          }),
        ];

        const result = await listPayload(list);

        expect(result).toEqual(list);
        expect(result[0]).not.toBe(list[0]);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it("emits no warning for an empty list", async () => {
        const result = await listPayload([]);

        expect(result).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe("updateBorrowStatus", () => {
    it("sends PATCH to /api/borrow/:id with { status } body and returns updated request", async () => {
      const expected = makeBorrowRequest({ status: BorrowStatus.LENT });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: expected }));

      const result = await client.updateBorrowStatus(
        REQUEST_ID,
        BorrowStatus.LENT,
      );

      expect(result).toEqual(expected);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${ENDPOINT}/api/borrow/${REQUEST_ID}`);
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ status: BorrowStatus.LENT });
    });

    it("throws with formatted message on INVALID_STATUS_TRANSITION", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "INVALID_STATUS_TRANSITION",
              message: "Cannot transition from RETURNED to PENDING",
            },
          },
          400,
        ),
      );

      await expect(
        client.updateBorrowStatus(REQUEST_ID, BorrowStatus.PENDING),
      ).rejects.toThrow(
        "INVALID_STATUS_TRANSITION: Cannot transition from RETURNED to PENDING",
      );
    });
  });

  describe("updateMemberSettings", () => {
    function makeMember(overrides: Partial<FamilyMember> = {}): FamilyMember {
      return {
        userId: OWNER_ID,
        displayName: "Alice",
        canLend: BoolFlag.TRUE,
        readmooName: "alice@readmoo",
        ...overrides,
      };
    }

    it("sends PATCH with only canLend when only canLend provided", async () => {
      const expected = makeMember({ canLend: BoolFlag.FALSE });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: expected }));

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        canLend: BoolFlag.FALSE,
      });

      expect(result).toEqual(expected);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        `${ENDPOINT}/api/family/${FAMILY_ID}/member/${OWNER_ID}`,
      );
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({ canLend: BoolFlag.FALSE });
    });

    it("sends PATCH with only readmooName when only readmooName provided", async () => {
      const expected = makeMember({ readmooName: "newname" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: expected }));

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        readmooName: "newname",
      });

      expect(result).toEqual(expected);
      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ readmooName: "newname" });
    });

    it("sends PATCH with both canLend and readmooName when both provided", async () => {
      const expected = makeMember({
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: expected }));

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });

      expect(result).toEqual(expected);
      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });
    });

    it("throws with formatted message on error envelope", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "Cannot modify another member",
            },
          },
          403,
        ),
      );

      await expect(
        client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
          canLend: BoolFlag.FALSE,
        }),
      ).rejects.toThrow("FORBIDDEN: Cannot modify another member");
    });
  });
});
