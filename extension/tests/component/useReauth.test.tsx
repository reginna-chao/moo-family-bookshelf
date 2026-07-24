import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useReauth } from "@/dialog/useReauth";
import type { ApiClient } from "@/api/client";
import {
  USER_ID_KEY,
  FAMILY_ID_KEY,
  DISPLAY_NAME_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  RECOVERY_COOLDOWN_UNTIL_KEY,
} from "@/constants";

/**
 * useReauth drives the in-place re-verification prompt shown when a dead token
 * can only be recovered by re-supplying the user's PWA-login verification secret
 * (security-ux Invariant 2). It wires apiClient.onReauthRequired; on the signal
 * it reads userId/familyId/displayName from storage, drives the REAL
 * useVerificationPrompt, re-joins with the secret, persists the fresh token, and
 * self-dismisses.
 *
 * The real useVerificationPrompt hook is intentionally NOT mocked (mock policy);
 * only the ApiClient boundary and chrome.storage are stubbed.
 */

function seedStorage(
  data: Record<string, unknown> = {
    [USER_ID_KEY]: "u1",
    [FAMILY_ID_KEY]: "fam-1",
    [DISPLAY_NAME_KEY]: "小明",
  },
): void {
  vi.mocked(chrome.storage.local.get).mockResolvedValue(data as never);
}

function createApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    onReauthRequired: null,
    getVerifyMethod: vi.fn().mockResolvedValue({ data: { method: "pin", prompted: 0 } }),
    joinFamily: vi.fn().mockResolvedValue({
      data: { authToken: "fresh-token", expiresAt: 7777 },
    }),
    setAuthToken: vi.fn(),
    clearReauthPending: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

/** Fire the reauth signal and wait for the prompt to become active. */
async function triggerReauth(
  apiClient: ApiClient,
  result: { current: ReturnType<typeof useReauth> },
): Promise<void> {
  await act(async () => {
    apiClient.onReauthRequired?.();
  });
  await waitFor(() => expect(result.current.active).toBe(true));
}

describe("useReauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires apiClient.onReauthRequired on mount and clears it on unmount", () => {
    const apiClient = createApiClient();
    const { unmount } = renderHook(() => useReauth(apiClient));

    expect(apiClient.onReauthRequired).toBeInstanceOf(Function);

    unmount();
    expect(apiClient.onReauthRequired).toBeNull();
  });

  it("opens the verification prompt with the fetched method on the reauth signal", async () => {
    seedStorage();
    const apiClient = createApiClient({
      getVerifyMethod: vi.fn().mockResolvedValue({ data: { method: "pattern" } }),
    });
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    expect(result.current.method).toBe("pattern");
    expect(apiClient.getVerifyMethod).toHaveBeenCalledWith("u1");
  });

  it("re-joins with the secret, persists the fresh token, and closes the prompt on success", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("1234");
    });

    // joinFamily called with the collected secret (displayName preserved).
    expect(apiClient.joinFamily).toHaveBeenCalledWith("fam-1", "u1", "小明", {
      verifySecret: "1234",
    });
    // Fresh token primed in-memory and persisted with its expiry.
    expect(apiClient.setAuthToken).toHaveBeenCalledWith("fresh-token");
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        [AUTH_TOKEN_KEY]: "fresh-token",
        [TOKEN_EXPIRES_AT_KEY]: 7777,
      }),
    );
    // Prompt self-dismisses so the user continues where they were.
    expect(result.current.active).toBe(false);
  });

  it("clears the recovery cooldown and calls onSuccess exactly once on a successful re-verify", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReauth(apiClient, { onSuccess }));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("1234");
    });

    // A valid manual re-verify proves the credentials again, so a leftover
    // recovery cooldown must be removed and the caller notified once so the
    // stale 401 view reloads itself.
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      RECOVERY_COOLDOWN_UNTIL_KEY,
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not clear the cooldown or call onSuccess when the re-verify fails", async () => {
    seedStorage();
    const apiClient = createApiClient({
      joinFamily: vi
        .fn()
        .mockResolvedValue({ error: { code: "VERIFICATION_FAILED", message: "bad" } }),
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReauth(apiClient, { onSuccess }));

    await triggerReauth(apiClient, result);

    await act(async () => {
      await result.current.submit("0000");
    });

    // Failed verification leaves the cooldown intact and never signals success.
    expect(chrome.storage.local.remove).not.toHaveBeenCalledWith(
      RECOVERY_COOLDOWN_UNTIL_KEY,
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.active).toBe(true);
  });

  it("keeps the prompt open and surfaces an error when the secret is wrong, allowing retry", async () => {
    seedStorage();
    const joinFamily = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: "VERIFICATION_FAILED", message: "bad" } })
      .mockResolvedValueOnce({ data: { authToken: "ok-token", expiresAt: 5555 } });
    const apiClient = createApiClient({ joinFamily });
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);

    // First attempt: wrong secret → prompt stays, no token persisted.
    await act(async () => {
      await result.current.submit("0000");
    });
    expect(result.current.active).toBe(true);
    expect(result.current.error).toBe("驗證失敗，請重新輸入");
    expect(apiClient.setAuthToken).not.toHaveBeenCalled();

    // Retry with the right secret → recovers and closes.
    await act(async () => {
      await result.current.submit("1234");
    });
    expect(apiClient.setAuthToken).toHaveBeenCalledWith("ok-token");
    expect(result.current.active).toBe(false);
  });

  it("releases the reauth latch and closes the prompt when the user cancels", async () => {
    seedStorage();
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await triggerReauth(apiClient, result);
    expect(result.current.active).toBe(true);

    // Cancelling must release the client-side latch so a later authenticated
    // action can re-challenge, and close the prompt without joining.
    act(() => {
      result.current.cancel();
    });

    expect(apiClient.clearReauthPending).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(false);
    expect(apiClient.joinFamily).not.toHaveBeenCalled();
  });

  it("no-ops the reauth signal when userId or familyId is missing from storage", async () => {
    seedStorage({ [USER_ID_KEY]: "u1" }); // familyId absent
    const apiClient = createApiClient();
    const { result } = renderHook(() => useReauth(apiClient));

    await act(async () => {
      apiClient.onReauthRequired?.();
    });

    // Give any pending microtasks a chance; the prompt must stay closed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.active).toBe(false);
    expect(apiClient.joinFamily).not.toHaveBeenCalled();
  });
});
