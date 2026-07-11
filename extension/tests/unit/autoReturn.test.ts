import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectReturnedRequests,
  applyAutoReturns,
} from "@/sync/autoReturn";
import {
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
} from "@/api/client";

const OWNER_ID = "user-owner";
const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const THIRTY_MIN = 30 * 60 * 1000;

function makeRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    requestId: "req-1",
    familyId: "fam-1",
    borrowerId: "user-borrower",
    borrowerName: "Borrower",
    ownerId: OWNER_ID,
    bookId: "book-1",
    bookTitle: "測試書",
    bookAuthor: "作者",
    bookCoverUrl: "",
    status: BorrowStatus.LENT,
    createdAt: "2026-06-01T00:00:00.000Z",
    // Default: lent well over 30 minutes ago relative to NOW.
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("detectReturnedRequests", () => {
  // Every row starts from a request that WOULD be detected, then mutates a
  // single field to prove that field is decisive.
  const cases: Array<{
    name: string;
    request: Partial<BorrowRequest>;
    scrapedBookIds: string[];
    detected: boolean;
  }> = [
    {
      name: "owner + LENT + scraped + old enough → detected",
      request: {},
      scrapedBookIds: ["book-1"],
      detected: true,
    },
    {
      name: "owner mismatch → skipped",
      request: { ownerId: "someone-else" },
      scrapedBookIds: ["book-1"],
      detected: false,
    },
    {
      name: "status PENDING (not LENT) → skipped",
      request: { status: BorrowStatus.PENDING },
      scrapedBookIds: ["book-1"],
      detected: false,
    },
    {
      name: "status RETURNED (not LENT) → skipped",
      request: { status: BorrowStatus.RETURNED },
      scrapedBookIds: ["book-1"],
      detected: false,
    },
    {
      name: "bookId not in scraped set → skipped",
      request: {},
      scrapedBookIds: ["other-book"],
      detected: false,
    },
    {
      name: "updatedAt younger than 30min → skipped",
      request: { updatedAt: "2026-07-01T11:45:00.000Z" },
      scrapedBookIds: ["book-1"],
      detected: false,
    },
    {
      name: "updatedAt exactly 30min old → detected (>= boundary)",
      request: {
        updatedAt: new Date(NOW - THIRTY_MIN).toISOString(),
      },
      scrapedBookIds: ["book-1"],
      detected: true,
    },
    {
      name: "updatedAt unparseable (NaN) → skipped",
      request: { updatedAt: "not-a-date" },
      scrapedBookIds: ["book-1"],
      detected: false,
    },
  ];

  it.each(cases)("$name", ({ request, scrapedBookIds, detected }) => {
    const req = makeRequest(request);
    const result = detectReturnedRequests(
      [req],
      new Set(scrapedBookIds),
      OWNER_ID,
      NOW,
    );
    expect(result).toHaveLength(detected ? 1 : 0);
    if (detected) expect(result[0].requestId).toBe(req.requestId);
  });

  it("returns only the matching subset from a mixed list", () => {
    const hit = makeRequest({ requestId: "hit", bookId: "book-1" });
    const wrongOwner = makeRequest({
      requestId: "wrong-owner",
      bookId: "book-1",
      ownerId: "other",
    });
    const notScraped = makeRequest({
      requestId: "not-scraped",
      bookId: "book-2",
    });
    const pending = makeRequest({
      requestId: "pending",
      bookId: "book-1",
      status: BorrowStatus.PENDING,
    });

    const result = detectReturnedRequests(
      [hit, wrongOwner, notScraped, pending],
      new Set(["book-1"]),
      OWNER_ID,
      NOW,
    );

    expect(result.map((r) => r.requestId)).toEqual(["hit"]);
  });

  it("honours a custom minLentAgeMs threshold", () => {
    const req = makeRequest({ updatedAt: new Date(NOW - 60_000).toISOString() });

    // 1-min-old book is too young for the default 30-min gate...
    expect(
      detectReturnedRequests([req], new Set(["book-1"]), OWNER_ID, NOW),
    ).toHaveLength(0);

    // ...but passes a 30-second custom gate.
    expect(
      detectReturnedRequests([req], new Set(["book-1"]), OWNER_ID, NOW, 30_000),
    ).toHaveLength(1);
  });
});

describe("applyAutoReturns", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function createApiClient(
    updateBorrowStatus: ApiClient["updateBorrowStatus"],
  ): ApiClient {
    return { updateBorrowStatus } as unknown as ApiClient;
  }

  it("marks every request RETURNED and returns the success requestIds", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValue(makeRequest({ status: BorrowStatus.RETURNED }));
    const apiClient = createApiClient(updateBorrowStatus);
    const requests = [
      makeRequest({ requestId: "req-a" }),
      makeRequest({ requestId: "req-b" }),
    ];

    const returnedIds = await applyAutoReturns(apiClient, requests);

    expect(returnedIds).toEqual(["req-a", "req-b"]);
    expect(updateBorrowStatus).toHaveBeenCalledTimes(2);
    expect(updateBorrowStatus).toHaveBeenNthCalledWith(
      1,
      "req-a",
      BorrowStatus.RETURNED,
    );
    expect(updateBorrowStatus).toHaveBeenNthCalledWith(
      2,
      "req-b",
      BorrowStatus.RETURNED,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("continues past a per-request failure and returns only the successes", async () => {
    const updateBorrowStatus = vi
      .fn()
      .mockResolvedValueOnce(makeRequest({ status: BorrowStatus.RETURNED }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeRequest({ status: BorrowStatus.RETURNED }));
    const apiClient = createApiClient(updateBorrowStatus);
    const requests = [
      makeRequest({ requestId: "req-a" }),
      makeRequest({ requestId: "req-b" }),
      makeRequest({ requestId: "req-c" }),
    ];

    const returnedIds = await applyAutoReturns(apiClient, requests);

    expect(returnedIds).toEqual(["req-a", "req-c"]);
    expect(updateBorrowStatus).toHaveBeenCalledTimes(3);
    // The failure is logged but does not abort the remaining requests.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array for an empty request list without calling the API", async () => {
    const updateBorrowStatus = vi.fn();
    const apiClient = createApiClient(updateBorrowStatus);

    const returnedIds = await applyAutoReturns(apiClient, []);

    expect(returnedIds).toEqual([]);
    expect(updateBorrowStatus).not.toHaveBeenCalled();
  });
});
