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

function makeBorrowRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
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
          { error: { code: "FORBIDDEN", message: "Not a member of this family" } },
          403,
        ),
      );

      await expect(client.listBorrowRequests(FAMILY_ID)).rejects.toThrow(
        "FORBIDDEN: Not a member of this family",
      );
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
      expect(url).toBe(`${ENDPOINT}/api/family/${FAMILY_ID}/member/${OWNER_ID}`);
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
          { error: { code: "FORBIDDEN", message: "Cannot modify another member" } },
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
