import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useEffect } from "react";
import { FamilyDataProvider, useFamilyData } from "@/dialog/FamilyDataContext";
import { useBorrowAction, type BorrowAction } from "@/dialog/useBorrowAction";
import type { FamilyShelfBook } from "@/dialog/useFamilyShelfBooks";
import { BoolFlag } from "@/api/client";
import type { ApiClient, BookEntry, FamilyBookshelf } from "@/api/client";
import {
  seenKey,
  chipsKey,
  FAMILY_ID_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "@/constants";
import { buildStorePageIndex } from "moo-family-bookshelf-shared/storePage/index";
import { createAccountSettingsServer } from "../helpers/accountSettingsServer";

/**
 * FamilyDataProvider exposes a `reloadSignal` prop: bumping the number re-runs
 * the initial load (members → bookshelf → borrow) IN PLACE. App bumps it after a
 * successful re-verification so a stale 401/error view reloads itself without
 * remounting the mounted children (which would lose their local state).
 *
 * Mock policy: only the ApiClient boundary + chrome.storage are stubbed; the
 * real provider + real useFamilyData/useFamilyShelfPrefs run.
 *
 * Hostile error envelopes: both load paths read the `{ data, error }` envelope through `readEnvelope`,
 * which bare-casts `response.json()` (extension/src/api/client.ts), and the endpoint is
 * user-configurable (BYO backend via the sync code's `@host`), so `error.message` is `unknown` at
 * runtime. Each path dropped it straight into React state that the shelf renders as a JSX child: React
 * 19 throws on an object/array and the Dialog mounts no ErrorBoundary, so a refused refresh used to
 * blank the whole overlay until reload. The quieter half of the same bug: an absent or empty message
 * left the error state blank, so a failed load reported nothing. This provider is where BOTH sites
 * converge, so one table serves the hostile envelope to `getFamilyMembers` AND `getFamilyBookshelf` in
 * the same render — a regression at either fails here. The exhaustive value-domain proof for the
 * coercion lives in tests/unit/safeErrorText.test.ts; these pin the wiring and the copy. StateProbe
 * renders the two error strings as JSX children on purpose: that is the shape every real consumer
 * uses (FamilyShelf / MemberList), and exactly where a non-string slipping past the guard makes React
 * 19 throw — so a regression fails the render, not just an assertion.
 *
 * Update tracking: the 「更新」 chip is a diff between each member's `lastUpdated` on the wire and the
 * baseline stored under `seenKey(userId)` (shared/src/familyShelf/updateTracking.ts). The provider
 * used to hand the tracker a synthesized `lastUpdated: null` for every member (the Extension's
 * `FamilyBookshelf` type lacked the field — issue #169), and `computeFreshBookIds` reads `null` as
 * "nothing to diff against", so an EXISTING member's newly shared books never got a chip; only a member
 * absent from the baseline did. The provider now passes the wire members through on load and keeps
 * them for `markBookshelfSeen`, mirroring the PWA (`pwa/src/hooks/useFamilyData.tsx`). The pure diff
 * is proven in tests/unit/updateTracking.test.ts; these pin the WIRING — that the real `lastUpdated`
 * reaches the tracker at both call sites.
 */

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: { familyId: "fam-1", ownerId: "user-1", members: [] },
    }),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-1", members: [] } }),
    listBorrowRequests: vi.fn().mockResolvedValue([]),
    getPersonalBooks: vi.fn().mockResolvedValue({ data: {} }),
    ...overrides,
  } as unknown as ApiClient;
}

/** Counts how many times the child subtree mounts (empty-dep effect fires). */
let childMountCount = 0;
function MountCounter() {
  useEffect(() => {
    childMountCount += 1;
  }, []);
  return null;
}

/** Surfaces the load states + member count; the error strings render as JSX children like every real
 *  consumer, so a non-string fails the render. See the file header, "Hostile error envelopes". */
function StateProbe() {
  const {
    membersState,
    bookshelfState,
    members,
    membersError,
    bookshelfError,
  } = useFamilyData();
  return (
    <div>
      <span data-testid="members-state">{membersState}</span>
      <span data-testid="bookshelf-state">{bookshelfState}</span>
      <span data-testid="members-count">{members.length}</span>
      <span data-testid="members-error">{membersError}</span>
      <span data-testid="bookshelf-error">{bookshelfError}</span>
    </div>
  );
}

function renderProvider(apiClient: ApiClient, reloadSignal: number) {
  return render(
    <FamilyDataProvider
      familyId="fam-1"
      userId="user-1"
      apiClient={apiClient}
      reloadSignal={reloadSignal}
    >
      <MountCounter />
      <StateProbe />
    </FamilyDataProvider>,
  );
}

describe("FamilyDataProvider reloadSignal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childMountCount = 0;
    // Bookshelf refresh reads seen/chips keys from storage — resolve empty.
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
  });

  afterEach(async () => {
    // Flush pending async effects before cleanup so no state update leaks.
    await act(async () => {});
  });

  it("re-runs the initial load when the signal bumps, recovering a prior error to data", async () => {
    // First load fails at members; the second (post-bump) load succeeds.
    const getFamilyMembers = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code: "SERVER_ERROR", message: "boom" },
      })
      .mockResolvedValueOnce({
        data: {
          familyId: "fam-1",
          ownerId: "user-1",
          members: [{ userId: "user-2", displayName: "Alice" }],
        },
      });
    const apiClient = createMockApiClient({ getFamilyMembers });

    const { rerender } = renderProvider(apiClient, 0);

    // Initial load lands in an error state with no members.
    await waitFor(() => {
      expect(screen.getByTestId("members-state")).toHaveTextContent("error");
    });
    expect(screen.getByTestId("members-count")).toHaveTextContent("0");

    // Bump the signal — provider re-runs the load in place.
    rerender(
      <FamilyDataProvider
        familyId="fam-1"
        userId="user-1"
        apiClient={apiClient}
        reloadSignal={1}
      >
        <MountCounter />
        <StateProbe />
      </FamilyDataProvider>,
    );

    // The error recovers to ready with the freshly fetched member.
    await waitFor(() => {
      expect(screen.getByTestId("members-state")).toHaveTextContent("ready");
    });
    expect(screen.getByTestId("members-count")).toHaveTextContent("1");

    // Both members + bookshelf were re-fetched (once per signal value).
    expect(getFamilyMembers).toHaveBeenCalledTimes(2);
    expect(apiClient.getFamilyBookshelf).toHaveBeenCalledTimes(2);
  });

  it("lets only the newest run start the bookshelf and borrow loads when a bump lands mid-members", async () => {
    const membersOk = {
      data: { familyId: "fam-1", ownerId: "user-1", members: [] },
    };
    const answers: Array<(value: typeof membersOk) => void> = [];
    const getFamilyMembers = vi.fn(
      () =>
        new Promise<typeof membersOk>((resolve) => {
          answers.push(resolve);
        }),
    );
    const apiClient = createMockApiClient({
      getFamilyMembers:
        getFamilyMembers as unknown as ApiClient["getFamilyMembers"],
    });

    const { rerender } = renderProvider(apiClient, 0);
    rerender(
      <FamilyDataProvider
        familyId="fam-1"
        userId="user-1"
        apiClient={apiClient}
        reloadSignal={1}
      >
        <MountCounter />
        <StateProbe />
      </FamilyDataProvider>,
    );
    expect(getFamilyMembers).toHaveBeenCalledTimes(2);

    // The superseded run's members answer first: that run must stop there.
    await act(async () => {
      answers[0]?.(membersOk);
    });
    expect(apiClient.getFamilyBookshelf).not.toHaveBeenCalled();
    expect(apiClient.listBorrowRequests).not.toHaveBeenCalled();

    await act(async () => {
      answers[1]?.(membersOk);
    });
    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("ready");
    });
    expect(apiClient.getFamilyBookshelf).toHaveBeenCalledTimes(1);
    expect(apiClient.listBorrowRequests).toHaveBeenCalledTimes(1);
  });

  it("reloads without remounting the mounted children", async () => {
    const apiClient = createMockApiClient();

    const { rerender } = renderProvider(apiClient, 0);

    await waitFor(() => {
      expect(screen.getByTestId("members-state")).toHaveTextContent("ready");
    });
    expect(childMountCount).toBe(1);

    rerender(
      <FamilyDataProvider
        familyId="fam-1"
        userId="user-1"
        apiClient={apiClient}
        reloadSignal={1}
      >
        <MountCounter />
        <StateProbe />
      </FamilyDataProvider>,
    );

    // The data re-fetches...
    await waitFor(() => {
      expect(apiClient.getFamilyMembers).toHaveBeenCalledTimes(2);
    });
    // ...but the children were never torn down and remounted.
    expect(childMountCount).toBe(1);
  });

  it("retries a prefs load that failed on a dead token, clearing the notice and restoring hidden books", async () => {
    const HIDDEN_REF = "user-2:210000000000001";
    const getPersonalBooks = vi
      .fn()
      .mockResolvedValueOnce({
        error: { code: "UNAUTHORIZED", message: "token expired" },
      })
      .mockResolvedValueOnce({
        data: { familyShelfPrefs: { hidden: [HIDDEN_REF], favorites: [] } },
      });
    const apiClient = createMockApiClient({ getPersonalBooks });

    function PrefsProbe() {
      const { prefsSyncFailed, hiddenRefs } = useFamilyData();
      return (
        <div>
          <span data-testid="prefs-sync-failed">{String(prefsSyncFailed)}</span>
          <span data-testid="hidden-refs">{[...hiddenRefs].join(",")}</span>
        </div>
      );
    }
    const providerWith = (reloadSignal: number) => (
      <FamilyDataProvider
        familyId="fam-1"
        userId="user-1"
        apiClient={apiClient}
        reloadSignal={reloadSignal}
      >
        <PrefsProbe />
      </FamilyDataProvider>
    );

    const { rerender } = render(providerWith(0));

    await waitFor(() => {
      expect(screen.getByTestId("prefs-sync-failed")).toHaveTextContent("true");
    });
    expect(getPersonalBooks).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("hidden-refs").textContent).toBe("");

    rerender(providerWith(1));

    await waitFor(() => {
      expect(screen.getByTestId("prefs-sync-failed")).toHaveTextContent(
        "false",
      );
    });
    expect(getPersonalBooks).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("hidden-refs").textContent).toBe(HIDDEN_REF);
  });
});

/** A non-string or empty `error.message` on either load path must neither crash the Dialog nor blank
 *  the error state. See the file header, "Hostile error envelopes". */
describe("FamilyDataProvider hostile error envelopes", () => {
  /** Literal from useFamilyDataMembers.ts and useFamilyDataBookshelf.ts — same copy at both call
   *  sites. */
  const LOAD_FAILED = "載入失敗，請稍後再試";

  const HOSTILE_MESSAGES = [
    { name: "an object message", message: { zh: "壞掉了" } },
    { name: "an array message", message: ["壞掉了"] },
    { name: "a number message", message: 500 },
    { name: "a null message", message: null },
    // Degrades too: a blank error is not a report.
    { name: "an empty-string message", message: "" },
  ];

  /** Same envelope on both load calls — one render covers both call sites. */
  function clientFailingBothPathsWith(message: unknown): ApiClient {
    return createMockApiClient({
      getFamilyMembers: vi
        .fn()
        .mockResolvedValue({ error: { code: "SERVER_ERROR", message } }),
      getFamilyBookshelf: vi
        .fn()
        .mockResolvedValue({ error: { code: "SERVER_ERROR", message } }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    childMountCount = 0;
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it.each(HOSTILE_MESSAGES)(
    "falls back to the local load-failure copy on both paths for $name",
    async ({ message }) => {
      renderProvider(clientFailingBothPathsWith(message), 0);

      // Members resolves first, then bookshelf — waiting on the later one means
      // both error branches have committed.
      await waitFor(() => {
        expect(screen.getByTestId("bookshelf-state")).toHaveTextContent(
          "error",
        );
      });
      expect(screen.getByTestId("members-state")).toHaveTextContent("error");

      // Exact equality, not substring: it proves the fallback REPLACED the
      // hostile value rather than being appended next to a leaked one.
      expect(screen.getByTestId("members-error").textContent).toBe(LOAD_FAILED);
      expect(screen.getByTestId("bookshelf-error").textContent).toBe(
        LOAD_FAILED,
      );
    },
  );

  it("keeps a usable provider tree after a hostile envelope", async () => {
    // The regression proper: React 19 throwing on the error string tears the subtree down (white
    // Dialog). A mounted probe that never remounted proves the tree survived intact.
    renderProvider(clientFailingBothPathsWith({ zh: "壞掉了" }), 0);

    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("error");
    });
    expect(childMountCount).toBe(1);
    expect(screen.getByTestId("members-count")).toHaveTextContent("0");
  });

  it("passes a legitimate server message through on both paths", async () => {
    // The guard must not over-degrade: a real string is still what the user
    // sees, so the fallback never hides a server-supplied explanation.
    renderProvider(clientFailingBothPathsWith("帳號不存在"), 0);

    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("error");
    });
    expect(screen.getByTestId("members-error").textContent).toBe("帳號不存在");
    expect(screen.getByTestId("bookshelf-error").textContent).toBe(
      "帳號不存在",
    );
  });
});

/** The real wire `lastUpdated` must reach the 「更新」 tracker at both call sites (issue #169).
 *  See the file header, "Update tracking". */
describe("FamilyDataProvider update tracking", () => {
  const SEEN_AT = "2026-01-01T00:00:00Z";
  const SYNCED_AT = "2026-02-01T00:00:00Z";
  const SEEN_KEY = seenKey("user-1");
  const CHIPS_KEY = chipsKey("user-1");

  function makeBook(bookId: string): BookEntry {
    return {
      bookId,
      title: `書 ${bookId}`,
      author: "作者",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared: BoolFlag.TRUE,
    };
  }

  /** `user-2` shares b1 + b2; the baseline below has only seen b1. */
  function bookshelfWith(lastUpdated: string | null): FamilyBookshelf {
    return {
      familyId: "fam-1",
      members: [
        {
          userId: "user-2",
          displayName: "B",
          lastUpdated,
          books: [makeBook("b1"), makeBook("b2")],
        },
      ],
    };
  }

  function clientServing(bookshelf: FamilyBookshelf): ApiClient {
    return createMockApiClient({
      getFamilyBookshelf: vi.fn().mockResolvedValue({ data: bookshelf }),
    });
  }

  /** Renders the chip set sorted, so the assertion is order-independent. */
  function UpdatesProbe() {
    const { bookshelfState, updatedBookIds, markBookshelfSeen } =
      useFamilyData();
    return (
      <div>
        <span data-testid="bookshelf-state">{bookshelfState}</span>
        <span data-testid="updated-ids">
          {[...updatedBookIds].sort().join(",")}
        </span>
        <button onClick={markBookshelfSeen}>seen</button>
      </div>
    );
  }

  async function renderWithSeenBaseline(apiClient: ApiClient) {
    await act(async () => {
      render(
        <FamilyDataProvider
          familyId="fam-1"
          userId="user-1"
          apiClient={apiClient}
        >
          <UpdatesProbe />
        </FamilyDataProvider>,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("ready");
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // A baseline already exists for user-2 (not first use): it last saw b1
    // when user-2's shelf was stamped SEEN_AT.
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [SEEN_KEY]: { "user-2": { lastUpdated: SEEN_AT, bookIds: ["b1"] } },
    } as never);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("chips only the books an existing member added since the seen baseline", async () => {
    await renderWithSeenBaseline(clientServing(bookshelfWith(SYNCED_AT)));

    // b2 is new since SEEN_AT; b1 was already in the baseline.
    expect(screen.getByTestId("updated-ids").textContent).toBe("b2");
    // Not first use — the provider must not silently overwrite the baseline.
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("chips nothing when the member's shelf has not been re-saved since the baseline", async () => {
    await renderWithSeenBaseline(clientServing(bookshelfWith(SEEN_AT)));

    expect(screen.getByTestId("updated-ids").textContent).toBe("");
  });

  it("chips nothing for a member who has never synced (null lastUpdated)", async () => {
    // `null` is the tri-state's "nothing to diff against", not "changed".
    await renderWithSeenBaseline(clientServing(bookshelfWith(null)));

    expect(screen.getByTestId("updated-ids").textContent).toBe("");
  });

  it("records the wire lastUpdated in the baseline when the shelf is marked seen", async () => {
    await renderWithSeenBaseline(clientServing(bookshelfWith(SYNCED_AT)));

    await act(async () => {
      screen.getByRole("button", { name: "seen" }).click();
    });

    // The next load diffs against SYNCED_AT — a synthesized null here would
    // store "" and re-chip b2 on every subsequent load.
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    const written = vi.mocked(chrome.storage.local.set).mock
      .calls[0][0] as Record<string, unknown>;
    expect(written[SEEN_KEY]).toEqual({
      "user-2": { lastUpdated: SYNCED_AT, bookIds: ["b1", "b2"] },
    });
    expect(written[CHIPS_KEY]).toMatchObject({ bookIds: ["b2"] });
    // The chip survives the seen-mark (kept for 24h); the red dot clears.
    expect(screen.getByTestId("updated-ids").textContent).toBe("b2");
  });
});

/** #313: a successful bookshelf load rebuilds the store-page chip index, only while the switch is on.
 *  Observed through the storage write; `storage/storePageChip` is the real module. */
describe("FamilyDataProvider store-page chip index", () => {
  const VIEWER_BOOK = "210000000000001";
  const SHARED_BOOK = "210000000000002";
  const UNSHARED_BOOK = "210000000000003";

  function makeBook(bookId: string, isShared: BoolFlag): BookEntry {
    return {
      bookId,
      title: `書 ${bookId}`,
      author: "作者",
      isbn: "",
      coverUrl: "",
      readmooUrl: "",
      category: "",
      isShared,
    };
  }

  const BOOKSHELF: FamilyBookshelf = {
    familyId: "fam-1",
    members: [
      {
        userId: "user-1",
        displayName: "Me",
        lastUpdated: null,
        books: [makeBook(VIEWER_BOOK, BoolFlag.TRUE)],
      },
      {
        userId: "user-2",
        displayName: "wire name",
        lastUpdated: null,
        books: [
          makeBook(SHARED_BOOK, BoolFlag.TRUE),
          makeBook(UNSHARED_BOOK, BoolFlag.FALSE),
        ],
      },
    ],
  };

  function clientServing(bookshelfResponse: unknown): ApiClient {
    return createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-1",
          ownerId: "user-1",
          members: [
            { userId: "user-1", displayName: "Me" },
            { userId: "user-2", displayName: "Alice" },
          ],
        },
      }),
      getFamilyBookshelf: vi.fn().mockResolvedValue(bookshelfResponse),
    });
  }

  /** storage.local.get answers the switch with `flag` and the binding with the rendered user / family;
   *  every other key reads as absent. */
  function storeSwitchReads(flag: BoolFlag): void {
    const answers: Record<string, unknown> = {
      [STORE_PAGE_CHIP_ENABLED_KEY]: flag,
      [USER_ID_KEY]: "user-1",
      [FAMILY_ID_KEY]: "fam-1",
    };
    vi.mocked(chrome.storage.local.get).mockImplementation(((
      keys: string | string[],
    ) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Promise.resolve(
        Object.fromEntries(
          list
            .filter((key) => key in answers)
            .map((key) => [key, answers[key]]),
        ),
      );
    }) as never);
  }

  const INDEX_GATE_KEYS = [
    STORE_PAGE_CHIP_ENABLED_KEY,
    USER_ID_KEY,
    FAMILY_ID_KEY,
  ];

  function indexWrites(): Record<string, unknown>[] {
    return vi
      .mocked(chrome.storage.local.set)
      .mock.calls.map(([items]) => items as Record<string, unknown>)
      .filter((items) => STORE_PAGE_INDEX_KEY in items);
  }

  async function renderUntil(state: "ready" | "error", apiClient: ApiClient) {
    await act(async () => {
      renderProvider(apiClient, 0);
    });
    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent(state);
    });
    // Let the fire-and-forget index update finish its read before asserting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    childMountCount = 0;
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("writes the index of the loaded shelf, without the viewer, when the switch is on", async () => {
    storeSwitchReads(BoolFlag.TRUE);

    await renderUntil("ready", clientServing({ data: BOOKSHELF }));

    await waitFor(() => expect(indexWrites()).toHaveLength(1));
    const index = indexWrites()[0][STORE_PAGE_INDEX_KEY];
    // The display name comes from the members list, as on the family shelf; unshared books are dropped.
    expect(index).toEqual({
      ...buildStorePageIndex(
        [
          {
            userId: "user-2",
            displayName: "Alice",
            books: [{ bookId: SHARED_BOOK }],
          },
        ],
        "user-1",
        "fam-1",
        new Date(),
      ),
      updatedAt: expect.any(String),
    });
  });

  it("writes nothing when the switch is off", async () => {
    storeSwitchReads(BoolFlag.FALSE);

    await renderUntil("ready", clientServing({ data: BOOKSHELF }));

    expect(chrome.storage.local.get).toHaveBeenCalledWith(INDEX_GATE_KEYS);
    expect(indexWrites()).toHaveLength(0);
  });

  it("writes nothing when the bookshelf load fails", async () => {
    storeSwitchReads(BoolFlag.TRUE);

    await renderUntil(
      "error",
      clientServing({ error: { code: "SERVER_ERROR", message: "boom" } }),
    );

    expect(chrome.storage.local.get).not.toHaveBeenCalledWith(INDEX_GATE_KEYS);
    expect(indexWrites()).toHaveLength(0);
  });

  it("indexes on this open when the account's switch, off here, arrives with the open-time refresh (#460)", async () => {
    // Stateful storage: the refresh's write of the switch is what the index writer reads after the gate.
    const store: Record<string, unknown> = {
      [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE,
      [USER_ID_KEY]: "user-1",
      [FAMILY_ID_KEY]: "fam-1",
    };
    vi.mocked(chrome.storage.local.get).mockImplementation(((
      keys: string | string[],
    ) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Promise.resolve(
        Object.fromEntries(
          list.filter((key) => key in store).map((key) => [key, store[key]]),
        ),
      );
    }) as never);
    vi.mocked(chrome.storage.local.set).mockImplementation(((
      items: Record<string, unknown>,
    ) => {
      Object.assign(store, items);
      return Promise.resolve();
    }) as never);
    const server = createAccountSettingsServer({
      storePageChipEnabled: BoolFlag.TRUE,
    });
    let releaseRead!: () => void;
    server.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve({ data: { ...server.record } });
        }),
    );
    const apiClient = createMockApiClient({
      ...clientServing({ data: BOOKSHELF }),
      accountSettings: server.api,
      getEndpoint: server.client.getEndpoint,
    });

    await renderUntil("ready", apiClient);
    expect(indexWrites()).toHaveLength(0);

    await act(async () => {
      releaseRead();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(store[STORE_PAGE_CHIP_ENABLED_KEY]).toBe(BoolFlag.TRUE);
    await waitFor(() => expect(indexWrites()).toHaveLength(1));
  });
});

/** #464: once the family tree is torn down the client may already point at another server, so a
 *  refresh that an `await` resumes after the provider unmounted must send nothing. */
describe("FamilyDataProvider after unmount", () => {
  const BOOK: FamilyShelfBook = {
    bookId: "210000000000001",
    title: "書",
    author: "作者",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
    memberName: "Alice",
    isUpdated: BoolFlag.FALSE,
    ownerId: "user-2",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
  });

  afterEach(async () => {
    await act(async () => {});
  });

  it("sends no refresh request when a borrow or member action resumes after the unmount", async () => {
    let answerCreate!: () => void;
    const createBorrowRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answerCreate = resolve;
        }),
    );
    const apiClient = createMockApiClient({
      createBorrowRequest:
        createBorrowRequest as unknown as ApiClient["createBorrowRequest"],
    });

    let borrow!: BorrowAction["borrow"];
    let refreshMembers!: () => Promise<void>;
    let refreshBookshelf!: () => Promise<void>;
    function ActionProbe() {
      const family = useFamilyData();
      const action = useBorrowAction({
        apiClient,
        familyId: "fam-1",
        userId: "user-1",
        borrowRequests: family.borrowRequests,
        refreshBorrowRequests: family.refreshBorrowRequests,
      });
      borrow = action.borrow;
      refreshMembers = family.refreshMembers;
      refreshBookshelf = family.refreshBookshelf;
      return (
        <div>
          <span data-testid="members-state">{family.membersState}</span>
          <span data-testid="bookshelf-state">{family.bookshelfState}</span>
          <span data-testid="borrow-state">{family.borrowRequestsState}</span>
        </div>
      );
    }

    const { unmount } = render(
      <FamilyDataProvider
        familyId="fam-1"
        userId="user-1"
        apiClient={apiClient}
      >
        <ActionProbe />
      </FamilyDataProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("members-state")).toHaveTextContent("ready");
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("ready");
      expect(screen.getByTestId("borrow-state")).toHaveTextContent("loaded");
    });
    const refreshesSent = () => ({
      borrow: vi.mocked(apiClient.listBorrowRequests).mock.calls.length,
      members: vi.mocked(apiClient.getFamilyMembers).mock.calls.length,
      bookshelf: vi.mocked(apiClient.getFamilyBookshelf).mock.calls.length,
    });
    expect(refreshesSent()).toEqual({ borrow: 1, members: 1, bookshelf: 1 });
    vi.clearAllMocks();

    const borrowing = borrow(BOOK);
    unmount();
    answerCreate();
    await borrowing;
    await refreshMembers();
    await refreshBookshelf();

    expect(createBorrowRequest).toHaveBeenCalledTimes(1);
    expect(refreshesSent()).toEqual({ borrow: 0, members: 0, bookshelf: 0 });
  });
});
