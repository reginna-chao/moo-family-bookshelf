import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useEffect } from "react";
import {
  FamilyDataProvider,
  useFamilyData,
} from "@/dialog/FamilyDataContext";
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
    getFamilyMembers: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-1", ownerId: "user-1", members: [] } }),
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

/** Surfaces the load states + member count for assertions. */
function StateProbe() {
  const { membersState, bookshelfState, members } = useFamilyData();
  return (
    <div>
      <span data-testid="members-state">{membersState}</span>
      <span data-testid="bookshelf-state">{bookshelfState}</span>
      <span data-testid="members-count">{members.length}</span>
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
      .mockResolvedValueOnce({ error: { code: "SERVER_ERROR", message: "boom" } })
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
