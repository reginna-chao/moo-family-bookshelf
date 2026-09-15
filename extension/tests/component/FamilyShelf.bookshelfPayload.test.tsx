import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { FamilyShelf } from "@/dialog/FamilyShelf";
import { MemberDropdown } from "@/dialog/MemberDropdown";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import { ApiClient, BoolFlag } from "@/api/client";

vi.mock("@/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants")>();
  return { ...actual, DEFAULT_API_ENDPOINT: "https://default.workers.dev" };
});

// Mock useSearch to avoid debounce complexity, exactly as FamilyShelf.test.tsx does.
vi.mock("@/dialog/useSearch", () => ({
  useSearch: vi.fn().mockImplementation((items: unknown[]) => ({
    searchTerm: "",
    setSearchTerm: vi.fn(),
    resetSearch: vi.fn(),
    filteredItems: items,
    isFiltering: false,
  })),
}));

const MOCK_ENDPOINT = "https://test.workers.dev";
const FAMILY_ID = "fam-1";
const SELF_ID = "user-self";
const VALID_MEMBER_ID = "c".repeat(64);

/**
 * React's duplicate-key diagnostic, as React 19 words it. Pinned as a constant
 * so the negative assertion below and its positive twin at the bottom of this
 * file cannot drift apart.
 */
const DUPLICATE_KEY_WARNING = "same key";

/** The exact option labels the dropdown must show for this payload. */
const EXPECTED_OPTION_LABELS = [
  "所有人的書",
  "其他家人的書",
  "自己的書",
  "小明",
  "我的最愛",
  "隱藏的書",
];

function makeSharedBook(bookId: string, title: string) {
  return {
    bookId,
    title,
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: `https://readmoo.com/book/${bookId}`,
    category: "",
    isShared: BoolFlag.TRUE,
  };
}

/**
 * The payload issue #155 is actually about.
 *
 * TWO members carry a `userId` that is not a usable string — an object and a
 * number, both shapes `JSON.parse` really produces from a self-hosted (BYO)
 * backend — plus a `displayName` that is not a string either. The TEXT layer
 * alone normalizes all four fields to `""` and KEEPS both members, so the
 * dropdown used to render two option buttons keyed on the SAME empty string,
 * both labelled `"" || "".slice(0, 8)` — i.e. blank. The structural layer drops
 * them instead, which is what this file pins end to end.
 *
 * The third member is addressable and must be the only one that survives.
 */
const HOSTILE_BOOKSHELF = {
  members: [
    {
      userId: { id: 1 },
      displayName: { "zh-TW": "壞資料甲" },
      books: [makeSharedBook("b-hostile-1", "書甲")],
    },
    {
      userId: 42,
      displayName: ["壞資料乙"],
      books: [makeSharedBook("b-hostile-2", "書乙")],
    },
    {
      userId: VALID_MEMBER_ID,
      displayName: "小明",
      books: [makeSharedBook("b-valid", "書丙")],
    },
  ],
};

function mockFetchSuccess(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data }),
  });
}

/**
 * A client whose `getFamilyBookshelf` is the REAL one — that is the whole point
 * of this file. Every other method is stubbed, so the only backend answer under
 * test is the bookshelf payload.
 */
function createClient(bookshelfData: unknown): ApiClient {
  const real = new ApiClient(MOCK_ENDPOINT);
  real.setAuthToken("test-token");
  globalThis.fetch = mockFetchSuccess(bookshelfData);

  return {
    getFamilyBookshelf: (familyId: string) => real.getFamilyBookshelf(familyId),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: { familyId: FAMILY_ID, ownerId: SELF_ID, members: [] },
    }),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: undefined }),
    updateFamilyPrefs: vi.fn().mockResolvedValue({ data: { ok: true } }),
    getEndpoint: vi.fn().mockReturnValue(MOCK_ENDPOINT),
    setEndpoint: vi.fn(),
    setAuthToken: vi.fn(),
  } as unknown as ApiClient;
}

function renderShelf(apiClient: ApiClient) {
  return render(
    <FamilyDataProvider
      familyId={FAMILY_ID}
      userId={SELF_ID}
      apiClient={apiClient}
    >
      <FamilyShelf userId={SELF_ID} />
    </FamilyDataProvider>,
  );
}

/** Open the member filter and return its option buttons. */
function openMemberFilter(): HTMLElement[] {
  fireEvent.click(screen.getByRole("button", { name: "篩選成員" }));
  return screen.getAllByRole("option");
}

/** The visible label of one option, without its trailing count. */
function optionLabel(option: HTMLElement): string {
  const label = option.querySelector(".moo-member-filter__option-label");
  if (label === null) {
    throw new Error("option is missing its .moo-member-filter__option-label");
  }
  return label.textContent ?? "";
}

/** The count badge of one option. */
function optionCount(option: HTMLElement): string {
  return option.querySelector(".moo-category__option-count")?.textContent ?? "";
}

/**
 * The end-to-end check issue #155 asked for: a hostile
 * `GET /api/family/:id/bookshelf` payload driven through the REAL API client,
 * `FamilyDataContext` and `FamilyShelf` into `dialog/MemberDropdown.tsx`.
 *
 * The issue's own proposed repro (an object-valued `displayName`) has been
 * green since the text layer landed, so it is deliberately NOT what is asserted
 * here. The defect is the IDENTITY half: a `userId` that cannot be a string
 * used to be blanked to `""` and kept, so two degraded members reached the
 * dropdown as two options sharing one React key and one blank label.
 */
describe("FamilyShelf member filter with a hostile bookshelf payload", () => {
  const originalFetch = globalThis.fetch;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // React reports a duplicate key through console.error; the validator's own
    // aggregate lines go to console.warn. Both are silenced so the assertions
    // read the calls rather than the terminal.
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    // Flush pending async effects from FamilyDataProvider before cleanup.
    await act(async () => {});
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("offers only the addressable member, with no blank-labelled option", async () => {
    renderShelf(createClient(HOSTILE_BOOKSHELF));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "篩選成員" }),
      ).toBeInTheDocument();
    });

    const labels = openMemberFilter().map(optionLabel);

    // The positive half: the selector really does find every option's label,
    // and the fixed options plus the ONE surviving member are all present.
    expect(labels).toEqual(EXPECTED_OPTION_LABELS);
    // The negative half: no option degraded into a blank label.
    expect(labels).not.toContain("");
    expect(labels.every((label) => label.trim() !== "")).toBe(true);
  });

  it("counts only the surviving member's books, not the dropped members'", async () => {
    renderShelf(createClient(HOSTILE_BOOKSHELF));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "篩選成員" }),
      ).toBeInTheDocument();
    });

    const options = openMemberFilter();

    // Three members each shared one book; two of them are unaddressable and
    // gone, so "所有人的書" must read 1 rather than 3.
    expect(optionCount(options[0])).toBe("1");
    expect(optionLabel(options[3])).toBe("小明");
    expect(optionCount(options[3])).toBe("1");
  });

  it("renders the member options without a duplicate React key", async () => {
    renderShelf(createClient(HOSTILE_BOOKSHELF));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "篩選成員" }),
      ).toBeInTheDocument();
    });

    openMemberFilter();

    const duplicateKeyCalls = errorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes(DUPLICATE_KEY_WARNING),
      ),
    );
    expect(duplicateKeyCalls).toEqual([]);
  });

  it("logs the validator's aggregate line instead of silently dropping the members", async () => {
    // The drop must be observable to a self-hoster debugging their backend —
    // and this is also the second, independent tell that layer 1 ran at all.
    renderShelf(createClient(HOSTILE_BOOKSHELF));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "篩選成員" }),
      ).toBeInTheDocument();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[bookshelfValidation] dropped 2 malformed family member(s)",
    );
  });
});

/**
 * The positive companion to the duplicate-key assertion above.
 *
 * That assertion is a negative one ("React never reported a duplicate key"), so
 * on its own it would stay green if React changed the wording, or if the option
 * buttons stopped being keyed at all. This case feeds `MemberDropdown` the
 * exact input the old boundary produced — two members collapsed onto the same
 * empty `userId` — and proves the detector fires, so the assertion above cannot
 * pass vacuously.
 */
describe("MemberDropdown duplicate-key detector", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("reports a duplicate key when two members collapse onto the same empty userId", () => {
    render(
      <MemberDropdown
        members={[
          { userId: "", displayName: "", books: [{ bookId: "b1" }] },
          { userId: "", displayName: "", books: [{ bookId: "b2" }] },
        ]}
        userId={SELF_ID}
        value="all-except-self"
        onChange={vi.fn()}
        favoriteCount={0}
        hiddenCount={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "篩選成員" }));

    const duplicateKeyCalls = errorSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes(DUPLICATE_KEY_WARNING),
      ),
    );
    expect(duplicateKeyCalls.length).toBeGreaterThan(0);
  });
});
