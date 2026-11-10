import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ApiClient } from "@/api/client";
import {
  useVerifyMethodFlow,
  VERIFY_SERVER_CHANGED_MESSAGE,
} from "@/dialog/useVerifyMethodFlow";

/**
 * A verification-method save stays on the server it was sent to: when the
 * client's endpoint moves while the save is in flight, nothing further is sent
 * and the hook shows `VERIFY_SERVER_CHANGED_MESSAGE`.
 *
 * Real code end to end: the hook, `saveVerifyMethod`, `ApiClient` and its
 * transport. Stubbed: `fetch`, which records every URL it receives and answers
 * like the Worker; the `PUT /verify` reply is held until the test releases it,
 * so the endpoint moves while the save is in flight.
 */

const USER_ID = "user-123";
const SERVER_A = "https://self-hosted-a.example";
const SERVER_B = "https://self-hosted-b.example";
const TOKEN = "a".repeat(64);
const VERIFY_PATH = `/api/user/${USER_ID}/verify`;

interface Reply {
  status: number;
  body: unknown;
}

const SECRET_REQUIRED: Reply = {
  status: 403,
  body: { error: { code: "VERIFICATION_REQUIRED", message: "server text" } },
};

describe("useVerifyMethodFlow", () => {
  let received: Array<{ server: string; route: string }>;
  let releasePut: (reply: Reply) => void;
  let putReply: Promise<Reply>;

  async function handleFetch(url: string, init?: RequestInit) {
    const { origin, pathname } = new URL(url);
    const route = `${init?.method ?? "GET"} ${pathname}`;
    received.push({ server: origin, route });
    const { status, body } =
      route === `PUT ${VERIFY_PATH}`
        ? await putReply
        : { status: 200, body: { data: { method: "none" } } };
    return new Response(JSON.stringify(body), { status });
  }

  beforeEach(() => {
    received = [];
    putReply = new Promise<Reply>((resolve) => {
      releasePut = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => handleFetch(url, init)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends nothing to the new server when the endpoint moves during the save", async () => {
    const apiClient = new ApiClient(SERVER_A);
    apiClient.setAuthToken(TOKEN);
    const { result } = renderHook(() =>
      useVerifyMethodFlow({ userId: USER_ID, apiClient }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.currentMethod).toBe("none");

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.handleSave("code");
    });
    await vi.waitFor(
      () =>
        expect(received.map((r) => r.route)).toContain(`PUT ${VERIFY_PATH}`),
      { timeout: 5000, interval: 5 },
    );
    apiClient.setEndpoint(SERVER_B);
    releasePut(SECRET_REQUIRED);
    await act(async () => {
      await pending;
    });

    expect(received.filter((r) => r.server === SERVER_B)).toEqual([]);
    expect(received).toEqual([
      { server: SERVER_A, route: `GET ${VERIFY_PATH}` },
      { server: SERVER_A, route: `PUT ${VERIFY_PATH}` },
    ]);
    expect(result.current.saveError).toBe(VERIFY_SERVER_CHANGED_MESSAGE);
    expect(result.current.saveState).toBe("error");
  });
});
