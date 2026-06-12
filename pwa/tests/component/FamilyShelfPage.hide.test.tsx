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
import { FamilyShelfPage } from "@/pages/FamilyShelfPage";
import { FamilyDataProvider } from "@/hooks/useFamilyData";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    ApiClient: vi.fn().mockImplementation(() => ({
      getFamilyBookshelf: vi.fn(),
    })),
  };
});

import { BoolFlag, type ApiClient } from "@/api/client";

function makeBooks(
  books: Array<{ bookId: string; title: string; author: string; isShared: BoolFlag }>,
) {
  return books.map((b) => ({
    bookId: b.bookId,
    title: b.title,
    author: b.author,
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/${b.bookId}`,
    category: "",
    isShared: b.isShared,
  }));
}

interface MockOpts {
  hidden?: string[];
  members?: unknown;
  bookshelf?: unknown;
  updateFamilyPrefs?: ReturnType<typeof vi.fn>;
}

function createApiClient(opts: MockOpts = {}) {
  return {
    getPersonalBooks: vi.fn().mockResolvedValue({
      data: { familyShelfPrefs: { hidden: opts.hidden ?? [] } },
    }),
    updateFamilyPrefs:
      opts.updateFamilyPrefs ??
      vi.fn().mockResolvedValue({ data: { ok: true, hidden: [] } }),
    getFamilyMembers: vi.fn().mockResolvedValue(
      opts.members ?? {
        data: { familyId: "fam-1", ownerId: "user-self", members: [] },
      },
    ),
    getFamilyBookshelf: vi.fn().mockResolvedValue(
      opts.bookshelf ?? { data: { familyId: "fam-1", members: [] } },
    ),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    createBorrowRequest: vi.fn(),
  } as unknown as ApiClient;
}

function renderPage(apiClient: ApiClient, userId = "user-self") {
  return render(
    <FamilyDataProvider familyId="fam-1" userId={userId} apiClient={apiClient}>
      <FamilyShelfPage userId={userId} />
    </FamilyDataProvider>,
  );
}

/** Alice with two shared books. */
function aliceTwoBooks() {
  return {
    members: {
      data: {
        familyId: "fam-1",
        ownerId: "user-self",
        members: [{ userId: "user-alice", displayName: "Alice" }],
      },
    },
    bookshelf: {
      data: {
        familyId: "fam-1",
        members: [
          {
            userId: "user-alice",
            displayName: "Alice",
            books: makeBooks([
              { bookId: "b1", title: "書一", author: "A", isShared: BoolFlag.TRUE },
              { bookId: "b2", title: "書二", author: "B", isShared: BoolFlag.TRUE },
            ]),
            lastUpdated: "2026-01-01",
          },
        ],
      },
    },
  };
}

describe("FamilyShelfPage — hide feature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => {});
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("hides a book from the default view and updates the heading count", async () => {
    const apiClient = createApiClient(aliceTwoBooks());
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "隱藏" })[0]);

    await waitFor(() => {
      expect(screen.queryByText("書一")).not.toBeInTheDocument();
    });
    expect(screen.getByText("(可見 1 本，隱藏 1 本)")).toBeInTheDocument();
    expect(screen.getByText("書二")).toBeInTheDocument();
  });

  it("omits the 隱藏 half when M is 0", async () => {
    const apiClient = createApiClient(aliceTwoBooks());
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
    });
    expect(screen.queryByText(/隱藏 \d+ 本/)).not.toBeInTheDocument();
  });

  it("「顯示已隱藏」lists ONLY hidden cards, and 取消隱藏 returns them to default view", async () => {
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      hidden: ["user-alice:b1"],
    });
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書二")).toBeInTheDocument();
    });
    expect(screen.queryByText("書一")).not.toBeInTheDocument();
    expect(screen.getByText("(可見 1 本，隱藏 1 本)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "顯示已隱藏" }));

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    expect(screen.queryByText("書二")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消隱藏" }));

    await waitFor(() => {
      expect(screen.queryByText("書一")).not.toBeInTheDocument();
    });
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
  });

  it("flushes the complete hidden array to updateFamilyPrefs after the debounce", async () => {
    const updateFamilyPrefs = vi
      .fn()
      .mockResolvedValue({ data: { ok: true, hidden: [] } });
    const apiClient = createApiClient({ ...aliceTwoBooks(), updateFamilyPrefs });
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });

    vi.useFakeTimers();
    fireEvent.click(screen.getAllByRole("button", { name: "隱藏" })[0]);
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    vi.useRealTimers();

    expect(updateFamilyPrefs).toHaveBeenCalledTimes(1);
    const [userIdArg, hiddenArg] = updateFamilyPrefs.mock.calls[0];
    expect(userIdArg).toBe("user-self");
    expect(hiddenArg).toEqual(["user-alice:b1"]);
  });

  it("ignores an orphan hidden ref: counts unaffected, all real cards shown", async () => {
    const apiClient = createApiClient({
      ...aliceTwoBooks(),
      hidden: ["ghost-owner:ghost-book"],
    });
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("書一")).toBeInTheDocument();
    });
    expect(screen.getByText("(可見 2 本)")).toBeInTheDocument();
    expect(screen.getByText("書二")).toBeInTheDocument();
  });

  it("can hide self's own book in the 所有人 view", async () => {
    const apiClient = createApiClient({
      members: {
        data: {
          familyId: "fam-1",
          ownerId: "user-self",
          members: [
            { userId: "user-self", displayName: "Me" },
            { userId: "user-alice", displayName: "Alice" },
          ],
        },
      },
      bookshelf: {
        data: {
          familyId: "fam-1",
          members: [
            {
              userId: "user-self",
              displayName: "Me",
              books: makeBooks([
                { bookId: "self-1", title: "我的書", author: "A", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2026-01-01",
            },
            {
              userId: "user-alice",
              displayName: "Alice",
              books: makeBooks([
                { bookId: "b2", title: "Alice的書", author: "B", isShared: BoolFlag.TRUE },
              ]),
              lastUpdated: "2026-01-01",
            },
          ],
        },
      },
    });
    renderPage(apiClient);

    await waitFor(() => {
      expect(screen.getByText("Alice的書")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("篩選成員"), {
      target: { value: "all" },
    });

    await waitFor(() => {
      expect(screen.getByText("我的書")).toBeInTheDocument();
    });

    // 我的書 is the first member's card → its 隱藏 button is the first.
    fireEvent.click(screen.getAllByRole("button", { name: "隱藏" })[0]);

    await waitFor(() => {
      expect(screen.queryByText("我的書")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Alice的書")).toBeInTheDocument();
  });
});
