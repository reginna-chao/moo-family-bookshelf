import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
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

describe("QrCodeLink", () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockToDataURL.mockReset();
  });

  // --- Group A: Default & Basic Display ---

  it("does not call createQrToken on mount", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "t", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await act(async () => { await Promise.resolve(); });

    expect(createQrToken).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "產生 QR Code" })).toBeInTheDocument();
  });

  it("shows the idle CTA text", () => {
    const apiClient = createMockApiClient();
    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);
    expect(screen.getByText("點擊產生 QR Code")).toBeInTheDocument();
  });

  it("shows the expiry hint text", () => {
    const apiClient = createMockApiClient();
    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);
    expect(
      screen.getByText("QR Code 5 分鐘後將自動過期，過期後可重新產生"),
    ).toBeInTheDocument();
  });

  it("shows the section title", () => {
    const apiClient = createMockApiClient();
    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);
    expect(screen.getByText("連結手機")).toBeInTheDocument();
  });

  it("shows the copy link button", () => {
    const apiClient = createMockApiClient();
    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);
    expect(screen.getByText("複製連結")).toBeInTheDocument();
  });

  // --- Group B: Reveal Flow ---

  it("clicking the blur QR triggers fetch and renders real QR", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "test-token-xyz", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    const img = await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(img).toBeInTheDocument();
    expect(createQrToken).toHaveBeenCalledTimes(1);
    expect(createQrToken).toHaveBeenCalledWith("uid123");
  });

  it("constructs the correct URL with token and renders it as QR", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "test-token-xyz", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(
      <QrCodeLink syncCode="moo-sync@custom.host" userId="uid123" apiClient={apiClient} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    const expectedUrl = buildPwaUrl("moo-sync@custom.host", "uid123", "test-token-xyz");
    expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, { width: 200, margin: 2 });
  });

  it("disables the QR button while loading", async () => {
    let resolveToken!: (v: unknown) => void;
    const tokenPromise = new Promise((r) => { resolveToken = r; });
    const createQrToken = vi.fn().mockReturnValue(tokenPromise);
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "QR Code 產生中" })).toBeDisabled();
    });

    // Additional clicks should not trigger extra fetch
    fireEvent.click(screen.getByRole("button", { name: "QR Code 產生中" }));
    expect(createQrToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveToken({ data: { token: "t1", expiresIn: 300 } });
    });
  });

  // --- Group C: Expiry & Regenerate ---

  it("shows expired UI when token expires", async () => {
    vi.useFakeTimers();

    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "t1", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    });
    expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });

    expect(screen.queryByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).not.toBeInTheDocument();
    expect(screen.getByText("QR Code 已過期")).toBeInTheDocument();
    expect(screen.getByText("重新產生")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("clicking regenerate fetches a new token", async () => {
    vi.useFakeTimers();

    const createQrToken = vi.fn()
      .mockResolvedValueOnce({ data: { token: "t1", expiresIn: 300 } })
      .mockResolvedValueOnce({ data: { token: "t2", expiresIn: 300 } });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新產生 QR Code" }));
    });

    expect(createQrToken).toHaveBeenCalledTimes(2);
    expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();

    vi.useRealTimers();
  });

  // --- Group D: Copy Link + Token Sharing ---

  it("clicking copy link in idle state triggers fetch then copies", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "copy-token", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByText("複製連結"));

    await waitFor(() => {
      expect(screen.getByText("已複製")).toBeInTheDocument();
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);
    const expectedUrl = buildPwaUrl("moo-sync", "uid123", "copy-token");
    expect(clipboardWriteText).toHaveBeenCalledWith(expectedUrl);
    // QR should also become visible since fetchAndActivate pushes to active
    expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();
  });

  it("clicking copy link in active state does NOT call API", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "share-token", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // First, reveal to enter active state
    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Now click copy — should NOT re-fetch
    fireEvent.click(screen.getByText("複製連結"));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalled();
    });

    expect(createQrToken).toHaveBeenCalledTimes(1);
    const expectedUrl = buildPwaUrl("moo-sync", "uid123", "share-token");
    expect(clipboardWriteText).toHaveBeenCalledWith(expectedUrl);
  });

  it("disables copy button while loading", async () => {
    let resolveToken!: (v: unknown) => void;
    const tokenPromise = new Promise((r) => { resolveToken = r; });
    const createQrToken = vi.fn().mockReturnValue(tokenPromise);
    const apiClient = createMockApiClient({ createQrToken });

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    await waitFor(() => {
      expect(screen.getByText("複製連結")).toBeDisabled();
    });

    await act(async () => {
      resolveToken({ data: { token: "t1", expiresIn: 300 } });
    });
  });

  // --- Group E: Error State ---

  it("shows error UI when createQrToken returns no token", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      error: { code: "UNAUTHORIZED", message: "Auth failed" },
    });
    const apiClient = createMockApiClient({ createQrToken });

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    await waitFor(() => {
      expect(screen.getByText("無法產生 QR Code，請稍後再試")).toBeInTheDocument();
    });
    expect(screen.getByText("重試")).toBeInTheDocument();
  });

  it("shows error UI when createQrToken throws", async () => {
    const createQrToken = vi.fn().mockRejectedValue(new Error("Network error"));
    const apiClient = createMockApiClient({ createQrToken });

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText("重試")).toBeInTheDocument();
  });

  it("shows fallback error message for non-Error rejection", async () => {
    const createQrToken = vi.fn().mockRejectedValue("string error");
    const apiClient = createMockApiClient({ createQrToken });

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    await waitFor(() => {
      expect(screen.getByText("QR Code 產生失敗")).toBeInTheDocument();
    });
  });

  it("clicking retry from error state re-fetches", async () => {
    const createQrToken = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ data: { token: "t2", expiresIn: 300 } });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />);

    // First click → error
    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    await waitFor(() => {
      expect(screen.getByText("重試")).toBeInTheDocument();
    });
    expect(createQrToken).toHaveBeenCalledTimes(1);

    // Click retry
    fireEvent.click(screen.getByRole("button", { name: "重試產生 QR Code" }));

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(createQrToken).toHaveBeenCalledTimes(2);
  });

  // --- Group F: Identity Reset ---

  it("resets to idle when syncCode changes", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "t1", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { rerender } = render(
      <QrCodeLink syncCode="moo-sync-1" userId="uid123" apiClient={apiClient} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(createQrToken).toHaveBeenCalledTimes(1);

    rerender(<QrCodeLink syncCode="moo-sync-2" userId="uid123" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.queryByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).not.toBeInTheDocument();
    });
    expect(screen.getByText("點擊產生 QR Code")).toBeInTheDocument();
    expect(createQrToken).toHaveBeenCalledTimes(1);
  });

  it("resets to idle when userId changes", async () => {
    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "t1", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { rerender } = render(
      <QrCodeLink syncCode="moo-sync" userId="userA" apiClient={apiClient} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    rerender(<QrCodeLink syncCode="moo-sync" userId="userB" apiClient={apiClient} />);

    await waitFor(() => {
      expect(screen.queryByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).not.toBeInTheDocument();
    });
    expect(screen.getByText("點擊產生 QR Code")).toBeInTheDocument();
  });

  // --- Group G: Cleanup ---

  it("does not setState after unmount when fetch resolves late", async () => {
    let resolveToken!: (v: unknown) => void;
    const tokenPromise = new Promise((r) => { resolveToken = r; });
    const createQrToken = vi.fn().mockReturnValue(tokenPromise);
    const apiClient = createMockApiClient({ createQrToken });

    const { unmount } = render(
      <QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));

    unmount();

    await act(async () => {
      resolveToken({ data: { token: "t1", expiresIn: 300 } });
    });
  });

  it("clears the expire timer on unmount", async () => {
    vi.useFakeTimers();

    const createQrToken = vi.fn().mockResolvedValue({
      data: { token: "t1", expiresIn: 300 },
    });
    const apiClient = createMockApiClient({ createQrToken });
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    const { unmount } = render(
      <QrCodeLink syncCode="moo-sync" userId="uid123" apiClient={apiClient} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "產生 QR Code" }));
    });
    expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toBeInTheDocument();

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });

    vi.useRealTimers();
  });
});
