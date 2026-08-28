import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { FamilyDataProvider, useFamilyData } from "@/hooks/useFamilyData";
import type { ApiClient } from "@/api/client";

/**
 * `FamilyDataProvider` is the PWA twin of the Extension's FamilyDataContext, so
 * its test sits in `component/` alongside the Extension counterpart rather than
 * in `unit/hooks/`: it needs a real render tree (provider + consumer), not
 * `renderHook`.
 *
 * Mock policy: only the ApiClient boundary is stubbed; the real provider and the
 * real `useFamilyData` / `useFamilyShelfPrefs` run.
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
    // Read once on mount by useFamilyShelfPrefs (viewer-private refs).
    getPersonalBooks: vi.fn().mockResolvedValue({ data: {} }),
    updateFamilyPrefs: vi
      .fn()
      .mockResolvedValue({ data: { ok: true, hidden: [], favorites: [] } }),
    ...overrides,
  } as unknown as ApiClient;
}

/**
 * Surfaces the load states + the two error strings for assertions.
 *
 * The errors are rendered as JSX children on purpose: that is the shape every
 * real consumer uses (FamilyShelfPage renders them), and it is exactly where a
 * non-string that slipped past the guard would make React 19 throw. A
 * regression therefore fails the render, not just an assertion.
 */
function StateProbe() {
  const { membersState, bookshelfState, membersError, bookshelfError } =
    useFamilyData();
  return (
    <div>
      <span data-testid="members-state">{membersState}</span>
      <span data-testid="bookshelf-state">{bookshelfState}</span>
      <span data-testid="members-error">{membersError}</span>
      <span data-testid="bookshelf-error">{bookshelfError}</span>
    </div>
  );
}

function renderProvider(apiClient: ApiClient) {
  return render(
    <FamilyDataProvider familyId="fam-1" userId="user-1" apiClient={apiClient}>
      <StateProbe />
    </FamilyDataProvider>,
  );
}

/**
 * Both load paths read the `{ data, error }` envelope through `readEnvelope`,
 * which bare-casts `response.json()` (pwa/src/api/client.ts), and the endpoint
 * is user-configurable (BYO backend via the sync code's `@host`), so
 * `error.message` is `unknown` at runtime. Each path drops it straight into
 * React state the family shelf renders as a JSX child: React 19 throws on an
 * object/array and the app mounts no ErrorBoundary, so a refused refresh used
 * to blank the page until reload. The quieter half of the same bug: an absent
 * or empty message left the error state blank, so a failed load reported
 * nothing at all.
 *
 * This provider is where BOTH sites converge, so one table serves the hostile
 * envelope to `getFamilyMembers` AND `getFamilyBookshelf` in the same render —
 * a regression at either one fails here. The exhaustive value-domain proof for
 * the coercion itself lives in extension/tests/unit/safeErrorText.test.ts
 * (shared helper, one copy); these pin the wiring and the copy.
 */
describe("FamilyDataProvider hostile error envelopes", () => {
  /** Literal from pwa/src/hooks/useFamilyData.tsx — same copy at both sites. */
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
  });

  afterEach(async () => {
    // Flush pending async effects before cleanup so no state update leaks.
    await act(async () => {});
  });

  it.each(HOSTILE_MESSAGES)(
    "falls back to the local load-failure copy on both paths for $name",
    async ({ message }) => {
      renderProvider(clientFailingBothPathsWith(message));

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
    // string tears the subtree down, so the page goes white. A probe still on
    // screen with both states readable proves the tree survived intact.
    renderProvider(clientFailingBothPathsWith(["壞掉了"]));

    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("error");
    });
    expect(screen.getByTestId("members-state")).toBeInTheDocument();
  });

  it("passes a legitimate server message through on both paths", async () => {
    // The guard must not over-degrade: a real string is still what the user
    // sees, so the fallback never hides a server-supplied explanation.
    renderProvider(clientFailingBothPathsWith("帳號不存在"));

    await waitFor(() => {
      expect(screen.getByTestId("bookshelf-state")).toHaveTextContent("error");
    });
    expect(screen.getByTestId("members-error").textContent).toBe("帳號不存在");
    expect(screen.getByTestId("bookshelf-error").textContent).toBe(
      "帳號不存在",
    );
  });
});
