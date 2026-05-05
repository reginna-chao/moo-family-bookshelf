import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QrCodeLink } from "@/dialog/QrCodeLink";
import { buildPwaUrl } from "@/constants";
import type { ApiClient } from "@/api/client";

const mockToDataURL = vi.fn();

vi.mock("qrcode", () => ({
  default: {
    toDataURL: (...args: unknown[]) => mockToDataURL(...args),
  },
}));

function createMockApiClient(
  overrides?: Partial<{ createQrToken: ApiClient["createQrToken"] }>,
): ApiClient {
  return {
    createQrToken: overrides?.createQrToken ?? vi.fn().mockResolvedValue({
      data: { token: "mock-qr-token-abc", expiresIn: 300 },
    }),
  } as unknown as ApiClient;
}

// Override jsdom's visibilityState getter and fire the corresponding event.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("QrCodeLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockToDataURL.mockReset();
    // Restore default visibility without dispatching the event —
    // RTL hasn't unmounted the component yet at this point, so dispatching
    // would trigger the still-mounted handler against cleared mocks.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  it("shows loading state initially", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {})); // never resolves
    const apiClient = createMockApiClient({
      createQrToken: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);
    expect(screen.getByText("產生 QR Code 中...")).toBeInTheDocument();
  });

  it("renders QR code image after generation", async () => {
    const fakeDataUrl = "data:image/png;base64,fakepng";
    mockToDataURL.mockResolvedValue(fakeDataUrl);
    const apiClient = createMockApiClient();

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);

    const img = await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", fakeDataUrl);
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("height", "200");
  });

  it("hides loading state after QR code is generated", async () => {
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");
    const apiClient = createMockApiClient();

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(screen.queryByText("產生 QR Code 中...")).not.toBeInTheDocument();
  });

  it("shows hint text", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    const apiClient = createMockApiClient({
      createQrToken: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);
    expect(
      screen.getByText("用手機掃描 QR Code 或複製連結，即可在行動裝置上使用墨家書櫃"),
    ).toBeInTheDocument();
  });

  it("shows section title", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    const apiClient = createMockApiClient({
      createQrToken: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);
    expect(screen.getByText("連結手機")).toBeInTheDocument();
  });

  it("constructs the correct URL with fragment params including qrToken", async () => {
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");
    const syncCode = "moo-abc-key123@custom.host";
    const userId = "user1";
    const apiClient = createMockApiClient();

    render(<QrCodeLink syncCode={syncCode} userId={userId} apiClient={apiClient} />);

    // Wait for the token to be fetched and the QR code to regenerate with it
    const expectedUrl = buildPwaUrl(syncCode, userId, "mock-qr-token-abc");
    await waitFor(() => {
      expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, {
        width: 200,
        margin: 2,
      });
    });
  });

  it("shows error message when QR code generation fails", async () => {
    mockToDataURL.mockRejectedValue(new Error("Canvas not available"));
    const apiClient = createMockApiClient();

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("Canvas not available")).toBeInTheDocument();
    });
    expect(screen.queryByText("產生 QR Code 中...")).not.toBeInTheDocument();
  });

  it("shows fallback error message for non-Error rejections", async () => {
    mockToDataURL.mockRejectedValue("something went wrong");
    const apiClient = createMockApiClient();

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByText("QR Code 產生失敗")).toBeInTheDocument();
    });
  });

  it("regenerates QR code when syncCode changes", async () => {
    const dataUrl1 = "data:image/png;base64,first";
    const dataUrl2 = "data:image/png;base64,second";
    // Use mockImplementation to always resolve (token fetch may trigger extra QR generations)
    let callCount = 0;
    mockToDataURL.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount <= 1 ? dataUrl1 : dataUrl2);
    });
    const apiClient = createMockApiClient();

    const { rerender } = render(
      <QrCodeLink syncCode="moo-abc-key1" userId="user1" apiClient={apiClient} />,
    );

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();
    });

    // Reset call count before rerender so the new QR code gets a different data URL
    callCount = 0;
    mockToDataURL.mockImplementation(() => Promise.resolve(dataUrl2));

    rerender(<QrCodeLink syncCode="moo-abc-key2" userId="user1" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl2);
    });
  });

  it("regenerates QR code when userId changes", async () => {
    const dataUrl1 = "data:image/png;base64,first";
    const dataUrl2 = "data:image/png;base64,second";
    mockToDataURL.mockImplementation(() => Promise.resolve(dataUrl1));
    const apiClient = createMockApiClient();

    const { rerender } = render(
      <QrCodeLink syncCode="moo-abc-key1" userId="userA" apiClient={apiClient} />,
    );

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();
    });

    mockToDataURL.mockImplementation(() => Promise.resolve(dataUrl2));

    rerender(<QrCodeLink syncCode="moo-abc-key1" userId="userB" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl2);
    });
  });

  it("shows copy link button", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    const apiClient = createMockApiClient({
      createQrToken: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" apiClient={apiClient} />);
    expect(screen.getByText("複製連結")).toBeInTheDocument();
  });

  // --- QR Token tests ---

  it("fetches QR token on mount and includes it in QR code URL", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "test-token-xyz", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    expect(createQrToken).toHaveBeenCalledWith("uid123");
    const expectedUrl = buildPwaUrl("moo-sync", "uid123", "test-token-xyz");
    expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, { width: 200, margin: 2 });
  });

  it("generates QR code without token when token fetch fails", async () => {
    const createQrToken = vi.fn().mockRejectedValue(new Error("Network error"));
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    // Should still generate QR code with URL without token
    const expectedUrl = buildPwaUrl("moo-sync", "uid123");
    expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, { width: 200, margin: 2 });
  });

  it("generates QR code without token when API returns no data", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      error: { code: "UNAUTHORIZED", message: "Auth failed" },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    const expectedUrl = buildPwaUrl("moo-sync", "uid123");
    expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, { width: 200, margin: 2 });
  });

  it("refreshes QR token before expiry", async () => {
    vi.useFakeTimers();

    // Use a deferred promise so we control when the first token resolves
    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });
    let resolveSecond!: (v: unknown) => void;
    const secondCall = new Promise((r) => { resolveSecond = r; });

    const createQrToken = vi.fn()
      .mockReturnValueOnce(firstCall)
      .mockReturnValueOnce(secondCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // Resolve first token fetch
    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Advance timer to trigger refresh (expiresIn=300, refresh at 300-60=240s)
    await act(async () => {
      vi.advanceTimersByTime(240_000);
    });

    expect(createQrToken).toHaveBeenCalledTimes(2);

    // Resolve second to prevent warnings
    await act(async () => {
      resolveSecond({ data: { token: "token-2", expiresIn: 300 } });
    });

    vi.useRealTimers();
  });

  it("cleans up refresh timer on unmount", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });

    const createQrToken = vi.fn().mockReturnValueOnce(firstCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { unmount } = render(
      <QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />,
    );

    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);

    unmount();

    // Advance past refresh interval — should NOT trigger another call
    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // --- Visibility-aware refresh tests ---

  it("does not refresh when page is hidden as the timer fires", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });

    const createQrToken = vi.fn().mockReturnValueOnce(firstCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // First fetch resolves while page is visible (jsdom default).
    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Hide the page before the next refresh fires.
    await act(async () => {
      setVisibility("hidden");
    });

    // Timer fires but visibility check skips the fetch and does not reschedule.
    await act(async () => {
      vi.advanceTimersByTime(240_000);
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Even further idling stays at zero traffic.
    await act(async () => {
      vi.advanceTimersByTime(600_000);
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("resumes fetching when visibility returns after a skipped refresh", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });
    let resolveSecond!: (v: unknown) => void;
    const secondCall = new Promise((r) => { resolveSecond = r; });

    const createQrToken = vi.fn()
      .mockReturnValueOnce(firstCall)
      .mockReturnValueOnce(secondCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Hide and let the refresh timer fire (gets skipped, no reschedule).
    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      vi.advanceTimersByTime(240_000);
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Visibility returns — handler sees no pending timer and triggers a fresh fetch.
    await act(async () => {
      setVisibility("visible");
    });
    expect(createQrToken).toHaveBeenCalledTimes(2);

    // Resolve the second to flush microtasks and avoid unhandled promise warnings.
    await act(async () => {
      resolveSecond({ data: { token: "token-2", expiresIn: 300 } });
    });

    vi.useRealTimers();
  });

  it("does not double-fetch when visibility returns while a timer is still pending", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });

    const createQrToken = vi.fn().mockReturnValueOnce(firstCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // First fetch resolves and schedules the next timer (still pending).
    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Toggle hidden → visible without advancing the timer; the pending timer
    // means the visibility handler must NOT trigger a duplicate fetch.
    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      setVisibility("visible");
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("does not fetch on visibility change after unmount", async () => {
    vi.useFakeTimers();

    let resolveFirst!: (v: unknown) => void;
    const firstCall = new Promise((r) => { resolveFirst = r; });

    const createQrToken = vi.fn().mockReturnValueOnce(firstCall);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { unmount } = render(
      <QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />,
    );

    await act(async () => {
      resolveFirst({ data: { token: "token-1", expiresIn: 300 } });
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    unmount();

    // visibilitychange after unmount must not reach the (now-removed) listener.
    await act(async () => {
      setVisibility("hidden");
    });
    await act(async () => {
      setVisibility("visible");
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("does not double-fetch on parent re-render with stable apiClient and userId", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "token-1", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { rerender } = render(
      <QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />,
    );

    await waitFor(() => {
      expect(createQrToken).toHaveBeenCalledTimes(1);
    });

    // Re-render with identical apiClient reference and userId — the effect's
    // primitive deps are unchanged, so it must not re-run nor refetch.
    rerender(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // Flush a microtask to give any unintended fetch a chance to slip through.
    await act(async () => {
      await Promise.resolve();
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);
  });
});
