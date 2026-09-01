import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import React from "react";
import { buildBorrowFailureText } from "moo-family-bookshelf-shared/borrow/messages";
import { FamilyShelfPage } from "@/pages/FamilyShelfPage";
import { FamilyDataProvider } from "@/hooks/useFamilyData";

/**
 * The failed-borrow banner on the PWA family shelf — the mirror of
 * `extension/tests/component/FamilyShelf.borrow.test.tsx`.
 *
 * Both borrow handlers used to swallow every rejection with a bare `catch {}`
 * ("errors surface via the borrow tab"), which they cannot: a failed create
 * writes no request, so the borrow page has nothing to show and the button did
 * nothing at all. These tests prove the report actually reaches the DOM.
 *
 * The sentences are never spelled out here — they come from
 * `buildBorrowFailureText`, whose literals are pinned once in
 * `extension/tests/unit/borrowMessages.test.ts` (`.claude/rules/test.md` →
 * Anti-Drift).
 */

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    ApiClient: vi.fn().mockImplementation(() => ({
      getFamilyBookshelf: vi.fn(),
    })),
  };
});

import { ApiError, BoolFlag, type ApiClient } from "@/api/client";

const VIEWER_ID = "user-self";
const OWNER_ID = "user-alice";

interface MockOpts {
  createBorrowRequest?: ReturnType<typeof vi.fn>;
  listBorrowRequests?: ReturnType<typeof vi.fn>;
}

/** Alice (another member) sharing one book, so exactly one 申請借閱 button renders. */
function createApiClient(opts: MockOpts = {}): ApiClient {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: { familyShelfPrefs: { hidden: [], favorites: [] } },
    }),
    updateFamilyPrefs: vi
      .fn()
      .mockResolvedValue({ data: { ok: true, hidden: [], favorites: [] } }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-1",
        ownerId: VIEWER_ID,
        members: [{ userId: OWNER_ID, displayName: "Alice" }],
      },
    }),
    getFamilyBookshelf: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: OWNER_ID,
            displayName: "Alice",
            books: [
              {
                bookId: "b1",
                title: "書一",
                author: "A",
                isbn: "",
                coverUrl: "",
                readmooUrl: "https://readmoo.com/book/b1",
                category: "",
                isShared: BoolFlag.TRUE,
              },
            ],
            lastUpdated: "2026-01-01",
          },
        ],
      },
    }),
    listBorrowRequests:
      opts.listBorrowRequests ?? vi.fn().mockResolvedValue([]),
    createBorrowRequest:
      opts.createBorrowRequest ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient;
}

/**
 * Renders inside `act` on purpose: `findBy*` waits with the act environment
 * disabled, so a node appearing does not prove the provider's mount effects
 * (which publish the `apiClient`-backed loaders) have committed before the
 * click below (`.claude/rules/test.md` → Anti-Drift).
 */
async function renderPage(apiClient: ApiClient) {
  await act(async () => {
    render(
      <FamilyDataProvider
        familyId="fam-1"
        userId={VIEWER_ID}
        apiClient={apiClient}
      >
        <FamilyShelfPage userId={VIEWER_ID} />
      </FamilyDataProvider>,
    );
  });
  await waitFor(() => {
    expect(screen.getByText("書一")).toBeInTheDocument();
  });
}

async function clickBorrow() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "申請借閱" }));
  });
}

describe("FamilyShelfPage — borrow failure notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(async () => {
    await act(async () => {});
    localStorage.clear();
  });

  it("renders no alert before any borrow is attempted", async () => {
    await renderPage(createApiClient());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the mapped failure copy in a role=alert banner when the create rejects", async () => {
    const createBorrowRequest = vi
      .fn()
      .mockRejectedValue(new ApiError("DUPLICATE_REQUEST", "already pending"));
    await renderPage(createApiClient({ createBorrowRequest }));

    await clickBorrow();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        buildBorrowFailureText("DUPLICATE_REQUEST"),
      );
    });
    expect(createBorrowRequest).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the borrow request succeeds", async () => {
    const createBorrowRequest = vi.fn().mockResolvedValue(undefined);
    await renderPage(createApiClient({ createBorrowRequest }));

    await clickBorrow();

    expect(createBorrowRequest).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("re-mounts the alert node when the SAME failure happens a second time", async () => {
    // The behavioural claim behind the banner's `key`: two presses that fail
    // identically write the same string, React bails out on it, and a live
    // region that is never re-mounted never re-announces — the user presses
    // 申請借閱 again and neither the screen nor the screen reader reacts.
    // Without `key={borrowFailureKey}` React reuses the element in place and
    // the identity assertion below fails (verified against this React version).
    const createBorrowRequest = vi
      .fn()
      .mockRejectedValue(new ApiError("DUPLICATE_REQUEST", "already pending"));
    await renderPage(createApiClient({ createBorrowRequest }));

    await clickBorrow();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        buildBorrowFailureText("DUPLICATE_REQUEST"),
      );
    });
    const first = screen.getByRole("alert");

    await clickBorrow();

    await waitFor(() => {
      expect(screen.getByRole("alert")).not.toBe(first);
    });
    // Same sentence, new node — the text must NOT have changed, or the test
    // would be proving something React does for free.
    expect(screen.getByRole("alert")).toHaveTextContent(
      buildBorrowFailureText("DUPLICATE_REQUEST"),
    );
    expect(first).not.toBeInTheDocument();
    expect(createBorrowRequest).toHaveBeenCalledTimes(2);
  });

  it("removes the banner once a later borrow succeeds", async () => {
    const createBorrowRequest = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("RATE_LIMITED", "slow down"))
      .mockResolvedValue(undefined);
    await renderPage(createApiClient({ createBorrowRequest }));

    await clickBorrow();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        buildBorrowFailureText("RATE_LIMITED"),
      );
    });

    await clickBorrow();

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
