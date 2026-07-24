import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/api/client";
import { BoolFlag, BorrowStatus } from "@/api/types";
import type {
  BorrowRequest,
  CreateBorrowPayload,
  FamilyMember,
} from "@/api/types";

vi.mock("@/constants", () => ({
  DEFAULT_API_ENDPOINT: "https://default.workers.dev",
}));

const MOCK_ENDPOINT = "https://test.workers.dev";
const FAMILY_ID = "fam-abc";
const REQUEST_ID = "req-123";
const OWNER_ID = "a".repeat(64);
const BORROWER_ID = "b".repeat(64);

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

describe("ApiClient borrow methods", () => {
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
      globalThis.fetch = mockFetchSuccess(expected);

      const result = await client.createBorrowRequest(FAMILY_ID, payload);

      expect(result).toEqual(expected);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/family/${FAMILY_ID}/borrow`);
      expect(call[1].method).toBe("POST");
      expect(JSON.parse(call[1].body as string)).toEqual(payload);
      expect(call[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      );
    });

    it("throws with formatted message on error envelope (DUPLICATE_REQUEST)", async () => {
      globalThis.fetch = mockFetchError(
        "DUPLICATE_REQUEST",
        "Active request already exists for this book",
        409,
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
      globalThis.fetch = mockFetchSuccess(list);

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result).toEqual(list);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/family/${FAMILY_ID}/borrow`);
      // Default fetch init has no method (GET)
      expect(call[1]?.method ?? "GET").toBe("GET");
    });

    it("returns empty array when API returns []", async () => {
      globalThis.fetch = mockFetchSuccess<BorrowRequest[]>([]);

      const result = await client.listBorrowRequests(FAMILY_ID);

      expect(result).toEqual([]);
    });

    it("throws with formatted message on error envelope", async () => {
      globalThis.fetch = mockFetchError(
        "FORBIDDEN",
        "Not a member of this family",
        403,
      );

      await expect(client.listBorrowRequests(FAMILY_ID)).rejects.toThrow(
        "FORBIDDEN: Not a member of this family",
      );
    });
  });

  describe("updateBorrowStatus", () => {
    it("sends PATCH to /api/borrow/:id with { status } body and returns updated request", async () => {
      const expected = makeBorrowRequest({ status: BorrowStatus.LENT });
      globalThis.fetch = mockFetchSuccess(expected);

      const result = await client.updateBorrowStatus(
        REQUEST_ID,
        BorrowStatus.LENT,
      );

      expect(result).toEqual(expected);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(`${MOCK_ENDPOINT}/api/borrow/${REQUEST_ID}`);
      expect(call[1].method).toBe("PATCH");
      expect(JSON.parse(call[1].body as string)).toEqual({
        status: BorrowStatus.LENT,
      });
    });

    it("throws with formatted message on INVALID_STATUS_TRANSITION", async () => {
      globalThis.fetch = mockFetchError(
        "INVALID_STATUS_TRANSITION",
        "Cannot transition from RETURNED to PENDING",
        400,
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
      globalThis.fetch = mockFetchSuccess(expected);

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        canLend: BoolFlag.FALSE,
      });

      expect(result).toEqual(expected);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe(
        `${MOCK_ENDPOINT}/api/family/${FAMILY_ID}/member/${OWNER_ID}`,
      );
      expect(call[1].method).toBe("PATCH");
      expect(JSON.parse(call[1].body as string)).toEqual({
        canLend: BoolFlag.FALSE,
      });
    });

    it("sends PATCH with only readmooName when only readmooName provided", async () => {
      const expected = makeMember({ readmooName: "newname" });
      globalThis.fetch = mockFetchSuccess(expected);

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        readmooName: "newname",
      });

      expect(result).toEqual(expected);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({
        readmooName: "newname",
      });
    });

    it("sends PATCH with both canLend and readmooName when both provided", async () => {
      const expected = makeMember({
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });
      globalThis.fetch = mockFetchSuccess(expected);

      const result = await client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });

      expect(result).toEqual(expected);
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(call[1].body as string)).toEqual({
        canLend: BoolFlag.TRUE,
        readmooName: "alice2",
      });
    });

    it("throws with formatted message on error envelope", async () => {
      globalThis.fetch = mockFetchError(
        "FORBIDDEN",
        "Cannot modify another member",
        403,
      );

      await expect(
        client.updateMemberSettings(FAMILY_ID, OWNER_ID, {
          canLend: BoolFlag.FALSE,
        }),
      ).rejects.toThrow("FORBIDDEN: Cannot modify another member");
    });
  });
});
