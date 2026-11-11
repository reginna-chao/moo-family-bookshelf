import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiClient } from "@/api/client";
import { FAMILY_ID_KEY, USER_ID_KEY } from "@/constants";
import { DEPARTURE_SERVER_CHANGED_MESSAGE } from "@/dialog/departureServerPin";
import { useFamilySettingsDelete } from "@/dialog/useFamilySettingsDelete";

/**
 * Account deletion keeps to the server its confirm step was opened on: a
 * current secret typed while the confirm step was open is never sent once the
 * client's server has changed; the hook stops at idle and shows
 * `DEPARTURE_SERVER_CHANGED_MESSAGE`.
 *
 * Real code end to end: the hook, `ApiClient` and its transport. Stubbed:
 * `fetch`, which records the server and route of every request it receives and
 * answers like the Worker (the account's method is PIN; a delete succeeds).
 * The whole request log is compared, so a request sent under any route, with
 * any method or to any server fails the test.
 */

const USER_ID = "user-1";
const FAMILY_ID = "fam-1";
const SERVER_A = "https://self-hosted-a.example";
const SERVER_B = "https://self-hosted-b.example";
const TOKEN = "a".repeat(64);
const VERIFY_ROUTE = `GET /api/user/${USER_ID}/verify`;

describe("useFamilySettingsDelete", () => {
  let received: Array<{ server: string; route: string }>;

  function handleFetch(url: string, init?: RequestInit) {
    const { origin, pathname } = new URL(url);
    const route = `${init?.method ?? "GET"} ${pathname}`;
    received.push({ server: origin, route });
    const body =
      route === VERIFY_ROUTE
        ? { data: { method: "pin" } }
        : { data: { ok: true } };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }

  beforeEach(async () => {
    received = [];
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      [USER_ID_KEY]: USER_ID,
      [FAMILY_ID_KEY]: FAMILY_ID,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handleFetch(url, init)),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await chrome.storage.local.clear();
  });

  it("sends no delete when the server changes while the confirm step is open", async () => {
    const apiClient = new ApiClient(SERVER_A);
    apiClient.setAuthToken(TOKEN);
    const onLeave = vi.fn();
    const { result } = renderHook(() =>
      useFamilySettingsDelete({
        userId: USER_ID,
        familyId: FAMILY_ID,
        apiClient,
        onLeave,
      }),
    );

    await act(async () => {
      await result.current.startConfirming();
    });
    expect(result.current.deleteState).toBe("confirming");
    expect(result.current.requiredMethod).toBe("pin");

    apiClient.setEndpoint(SERVER_B);
    await act(async () => {
      await result.current.handleDeleteConfirm("1234");
    });

    expect(received).toEqual([{ server: SERVER_A, route: VERIFY_ROUTE }]);
    expect(onLeave).not.toHaveBeenCalled();
    expect(result.current.deleteError).toBe(DEPARTURE_SERVER_CHANGED_MESSAGE);
    expect(result.current.deleteState).toBe("idle");
  });
});
