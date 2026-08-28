import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useEffect } from "react";
import { FamilyDataProvider, useFamilyData } from "@/dialog/FamilyDataContext";
import type { ApiClient } from "@/api/client";

/**
 * FamilyDataProvider exposes a `reloadSignal` prop: bumping the number re-runs
 * the initial load (members → bookshelf → borrow) IN PLACE. App bumps it after a
 * successful re-verification so a stale 401/error view reloads itself without
 * remounting the mounted children (which would lose their local state).
 *
 * Mock policy: only the ApiClient boundary + chrome.storage are stubbed; the
 * real provider + real useFamilyData/useFamilyShelfPrefs run.
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

/**
 * Surfaces the load states + member count for assertions.
 *
 * The two error strings are rendered as JSX children on purpose: that is the
 * shape every real consumer uses (FamilyShelf / MemberList render them), and it
 * is exactly where a non-string that slipped past the guard would make React 19
 * throw. A regression therefore fails the render, not just an assertion.
 */
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
});

/**
 * Both load paths read the `{ data, error }` envelope through `readEnvelope`,
 * which bare-casts `response.json()` (extension/src/api/client.ts), and the
 * endpoint is user-configurable (BYO backend via the sync code's `@host`), so
 * `error.message` is `unknown` at runtime. Each path drops it straight into
 * React state that the shelf renders as a JSX child: React 19 throws on an
 * object/array and the Dialog mounts no ErrorBoundary, so a refused refresh
 * used to blank the whole overlay until reload. The quieter half of the same
 * bug: an absent or empty message left the error state blank, so a failed load
 * reported nothing at all.
 *
 * This provider is where BOTH sites converge, so one table serves the hostile
 * envelope to `getFamilyMembers` AND `getFamilyBookshelf` in the same render —
 * a regression at either one fails here. The exhaustive value-domain proof for
 * the coercion itself lives in tests/unit/safeErrorText.test.ts; these pin the
 * wiring and the copy.
 */
describe("FamilyDataProvider hostile error envelopes", () => {
  /** Literal from FamilyDataContext.tsx — same copy at both call sites. */
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
    // What the regression is really about: React 19 throwing on the error
    // string tears the subtree down, so the Dialog goes white. A mounted probe
    // that never remounted proves the tree survived intact.
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
