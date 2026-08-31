import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  buildBorrowFailureText,
  BORROW_FAILURE_FALLBACK_TEXT,
} from "moo-family-bookshelf-shared/borrow/messages";
import { useBorrowAction } from "@/dialog/useBorrowAction";
import { ApiError } from "@/api/types";
import {
  BoolFlag,
  BorrowStatus,
  type ApiClient,
  type BorrowRequest,
} from "@/api/client";
import type { FamilyShelfBook } from "@/dialog/useFamilyShelfBooks";

/**
 * The Extension half of the 「申請借閱」 action hook. `pwa/tests/unit/hooks/
 * useBorrowAction.test.ts` is the deliberate mirror of this file: the two
 * production hooks are hand-kept copies, so each side needs its own proof.
 *
 * The failure sentences themselves are NOT re-declared here — they are pinned
 * once in `extension/tests/unit/borrowMessages.test.ts` and reached through
 * `buildBorrowFailureText`, so a copy change fails there instead of in five
 * places (`.claude/rules/test.md` → Anti-Drift).
 */

const FAMILY_ID = "fam-1";
const VIEWER_ID = "user-self";
const OWNER_ID = "user-alice";

const BOOK: FamilyShelfBook = {
  bookId: "b1",
  title: "書一",
  author: "作者一",
  isbn: "9789571234567",
  coverUrl: "https://cdn.readmoo.com/cover/b1.jpg",
  readmooUrl: "https://readmoo.com/book/b1",
  category: "文學",
  isShared: BoolFlag.TRUE,
  memberName: "Alice",
  ownerId: OWNER_ID,
  isUpdated: BoolFlag.FALSE,
};

/** Every code the shared copy table maps, driven end-to-end through the hook. */
const MAPPED_CODES = [
  "DUPLICATE_REQUEST",
  "RATE_LIMITED",
  "LENDING_DISABLED",
  "NOT_FAMILY_MEMBER",
  "INVALID_OWNER",
  "FAMILY_NOT_FOUND",
  "UNAUTHORIZED",
  "INVALID_COVER_URL",
  "NETWORK_ERROR",
];

/** Statuses that must NOT make the button read 申請中. */
const NON_PENDING_STATUSES: [string, BorrowStatus][] = [
  ["LENT", BorrowStatus.LENT],
  ["RETURNED", BorrowStatus.RETURNED],
  ["REJECTED", BorrowStatus.REJECTED],
  ["CANCELLED", BorrowStatus.CANCELLED],
];

function borrowRequest(overrides: Partial<BorrowRequest> = {}): BorrowRequest {
  return {
    requestId: "req-1",
    familyId: FAMILY_ID,
    borrowerId: VIEWER_ID,
    borrowerName: "我",
    ownerId: OWNER_ID,
    bookId: "b1",
    bookTitle: "書一",
    bookAuthor: "作者一",
    bookCoverUrl: "",
    status: BorrowStatus.PENDING,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  createBorrowRequest?: ReturnType<typeof vi.fn>;
  refreshBorrowRequests?: ReturnType<typeof vi.fn>;
  borrowRequests?: BorrowRequest[];
  userId?: string;
}

function renderBorrowAction(options: HarnessOptions = {}) {
  const createBorrowRequest =
    options.createBorrowRequest ?? vi.fn().mockResolvedValue(undefined);
  const refreshBorrowRequests =
    options.refreshBorrowRequests ?? vi.fn().mockResolvedValue(undefined);
  const apiClient = { createBorrowRequest } as unknown as ApiClient;

  const view = renderHook(
    ({ borrowRequests }: { borrowRequests: BorrowRequest[] }) =>
      useBorrowAction({
        apiClient,
        familyId: FAMILY_ID,
        userId: options.userId ?? VIEWER_ID,
        borrowRequests,
        refreshBorrowRequests,
      }),
    { initialProps: { borrowRequests: options.borrowRequests ?? [] } },
  );

  return { ...view, createBorrowRequest, refreshBorrowRequests };
}

describe("useBorrowAction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("borrow — success path", () => {
    it("sends the book's fields to createBorrowRequest and refreshes the list", async () => {
      const { result, createBorrowRequest, refreshBorrowRequests } =
        renderBorrowAction();

      await act(async () => {
        await result.current.borrow(BOOK);
      });

      expect(createBorrowRequest).toHaveBeenCalledTimes(1);
      expect(createBorrowRequest).toHaveBeenCalledWith(FAMILY_ID, {
        bookId: BOOK.bookId,
        bookTitle: BOOK.title,
        bookAuthor: BOOK.author,
        bookCoverUrl: BOOK.coverUrl,
        ownerId: BOOK.ownerId,
      });
      expect(refreshBorrowRequests).toHaveBeenCalledTimes(1);
      expect(result.current.failureText).toBe("");
    });
  });

  describe("borrow — failure reporting", () => {
    it.each(MAPPED_CODES)(
      "reports the %s copy and skips the refresh when the create rejects",
      async (code) => {
        const { result, refreshBorrowRequests } = renderBorrowAction({
          createBorrowRequest: vi
            .fn()
            .mockRejectedValue(new ApiError(code, "server side detail")),
        });

        await act(async () => {
          await result.current.borrow(BOOK);
        });

        expect(result.current.failureText).toBe(buildBorrowFailureText(code));
        // A mapped code must not silently degrade to the generic sentence.
        expect(result.current.failureText).not.toBe(
          BORROW_FAILURE_FALLBACK_TEXT,
        );
        // The early return: no request was created, so there is nothing to
        // refresh — and a refresh here would cost a needless round trip.
        expect(refreshBorrowRequests).not.toHaveBeenCalled();
      },
    );

    it("falls back to the generic copy for an unrecognized code", async () => {
      const { result } = renderBorrowAction({
        createBorrowRequest: vi
          .fn()
          .mockRejectedValue(new ApiError("SOMETHING_NEW", "unknown")),
      });

      await act(async () => {
        await result.current.borrow(BOOK);
      });

      expect(result.current.failureText).toBe(BORROW_FAILURE_FALLBACK_TEXT);
    });

    it.each([
      ["a plain Error carrying no code", new Error("boom")],
      ["a non-Error rejection value", "just a string"],
    ])("falls back to the generic copy for %s", async (_label, thrown) => {
      const { result, refreshBorrowRequests } = renderBorrowAction({
        createBorrowRequest: vi.fn().mockRejectedValue(thrown),
      });

      await act(async () => {
        await result.current.borrow(BOOK);
      });

      expect(result.current.failureText).toBe(BORROW_FAILURE_FALLBACK_TEXT);
      expect(refreshBorrowRequests).not.toHaveBeenCalled();
    });

    it("never paints server-supplied message text into the banner", async () => {
      // The API endpoint is user-configurable (BYO backend / sync-code @host),
      // so an envelope's `message` is attacker-controlled: only the `code` may
      // influence what the user reads.
      const hostileMessage = "點此輸入你的信用卡號 https://evil.example";
      const { result } = renderBorrowAction({
        createBorrowRequest: vi
          .fn()
          .mockRejectedValue(new ApiError("LENDING_DISABLED", hostileMessage)),
      });

      await act(async () => {
        await result.current.borrow(BOOK);
      });

      expect(result.current.failureText).toBe(
        buildBorrowFailureText("LENDING_DISABLED"),
      );
      expect(result.current.failureText).not.toContain(hostileMessage);
      expect(result.current.failureText).not.toContain("evil.example");
    });

    it("stays quiet when the create SUCCEEDED but the refresh rejected", async () => {
      // The request really was created; a failed list refresh only means the
      // on-screen list is stale. Reporting it as a borrow failure would tell
      // the user the opposite of the truth.
      const refreshBorrowRequests = vi
        .fn()
        .mockRejectedValue(new Error("list fetch failed"));
      const { result } = renderBorrowAction({ refreshBorrowRequests });

      await act(async () => {
        await expect(result.current.borrow(BOOK)).resolves.toBeUndefined();
      });

      expect(refreshBorrowRequests).toHaveBeenCalledTimes(1);
      expect(result.current.failureText).toBe("");
    });

    it("clears the report once a later borrow succeeds", async () => {
      const createBorrowRequest = vi
        .fn()
        .mockRejectedValueOnce(new ApiError("RATE_LIMITED", "slow down"))
        .mockResolvedValue(undefined);
      const { result, refreshBorrowRequests } = renderBorrowAction({
        createBorrowRequest,
      });

      await act(async () => {
        await result.current.borrow(BOOK);
      });
      expect(result.current.failureText).toBe(
        buildBorrowFailureText("RATE_LIMITED"),
      );

      await act(async () => {
        await result.current.borrow(BOOK);
      });

      expect(result.current.failureText).toBe("");
      expect(refreshBorrowRequests).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["an ApiError", new ApiError("DUPLICATE_REQUEST", "already pending")],
      ["a plain Error", new Error("boom")],
      ["a non-Error value", 42],
    ])(
      "resolves instead of rejecting when the create throws %s",
      async (_label, thrown) => {
        const { result } = renderBorrowAction({
          createBorrowRequest: vi.fn().mockRejectedValue(thrown),
        });

        await act(async () => {
          await expect(result.current.borrow(BOOK)).resolves.toBeUndefined();
        });
      },
    );
  });

  describe("pendingBookIds", () => {
    it("is empty when the viewer has no requests", () => {
      const { result } = renderBorrowAction();

      expect(result.current.pendingBookIds.size).toBe(0);
    });

    it("collects the bookIds of the viewer's own PENDING requests", () => {
      const { result } = renderBorrowAction({
        borrowRequests: [
          borrowRequest({ requestId: "req-1", bookId: "b1" }),
          borrowRequest({ requestId: "req-2", bookId: "b2" }),
        ],
      });

      expect([...result.current.pendingBookIds].sort()).toEqual(["b1", "b2"]);
    });

    it("excludes another member's pending request for the same book", () => {
      // Otherwise the viewer's button would read 申請中 for a request that is
      // not theirs, and they could never borrow the book.
      const { result } = renderBorrowAction({
        borrowRequests: [
          borrowRequest({ borrowerId: "user-bob", bookId: "b1" }),
        ],
      });

      expect(result.current.pendingBookIds.has("b1")).toBe(false);
    });

    it.each(NON_PENDING_STATUSES)(
      "excludes the viewer's %s request",
      (_label, status) => {
        const { result } = renderBorrowAction({
          borrowRequests: [borrowRequest({ bookId: "b1", status })],
        });

        expect(result.current.pendingBookIds.has("b1")).toBe(false);
      },
    );

    it("recomputes when the request list changes", () => {
      const { result, rerender } = renderBorrowAction();

      expect(result.current.pendingBookIds.size).toBe(0);

      rerender({ borrowRequests: [borrowRequest({ bookId: "b9" })] });

      expect([...result.current.pendingBookIds]).toEqual(["b9"]);
    });
  });
});
