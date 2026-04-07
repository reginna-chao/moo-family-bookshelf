import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QrCodeLink } from "@/dialog/QrCodeLink";
import { buildPwaUrl } from "@/constants";

const mockToDataURL = vi.fn();

vi.mock("qrcode", () => ({
  default: {
    toDataURL: (...args: unknown[]) => mockToDataURL(...args),
  },
}));

describe("QrCodeLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockToDataURL.mockReset();
  });

  it("shows loading state initially", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {})); // never resolves
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);
    expect(screen.getByText("產生 QR Code 中...")).toBeInTheDocument();
  });

  it("renders QR code image after generation", async () => {
    const fakeDataUrl = "data:image/png;base64,fakepng";
    mockToDataURL.mockResolvedValue(fakeDataUrl);

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);

    const img = await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", fakeDataUrl);
    expect(img).toHaveAttribute("width", "200");
    expect(img).toHaveAttribute("height", "200");
  });

  it("hides loading state after QR code is generated", async () => {
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");
    expect(screen.queryByText("產生 QR Code 中...")).not.toBeInTheDocument();
  });

  it("shows hint text", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);
    expect(
      screen.getByText("用手機掃描 QR Code 或複製連結，即可在行動裝置上使用墨家書櫃"),
    ).toBeInTheDocument();
  });

  it("shows section title", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);
    expect(screen.getByText("連結手機")).toBeInTheDocument();
  });

  it("constructs the correct URL with fragment params", async () => {
    mockToDataURL.mockResolvedValue("data:image/png;base64,fakepng");
    const syncCode = "moo-abc-key123@custom.host";
    const userId = "user1";

    render(<QrCodeLink syncCode={syncCode} userId={userId} />);

    await screen.findByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃");

    const expectedUrl = buildPwaUrl(syncCode, userId);
    expect(mockToDataURL).toHaveBeenCalledWith(expectedUrl, {
      width: 200,
      margin: 2,
    });
  });

  it("shows error message when QR code generation fails", async () => {
    mockToDataURL.mockRejectedValue(new Error("Canvas not available"));

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);

    await waitFor(() => {
      expect(screen.getByText("Canvas not available")).toBeInTheDocument();
    });
    expect(screen.queryByText("產生 QR Code 中...")).not.toBeInTheDocument();
  });

  it("shows fallback error message for non-Error rejections", async () => {
    mockToDataURL.mockRejectedValue("something went wrong");

    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);

    await waitFor(() => {
      expect(screen.getByText("QR Code 產生失敗")).toBeInTheDocument();
    });
  });

  it("regenerates QR code when syncCode changes", async () => {
    const dataUrl1 = "data:image/png;base64,first";
    const dataUrl2 = "data:image/png;base64,second";
    mockToDataURL.mockResolvedValueOnce(dataUrl1).mockResolvedValueOnce(dataUrl2);

    const { rerender } = render(
      <QrCodeLink syncCode="moo-abc-key1" userId="user1" />,
    );

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl1);
    });

    rerender(<QrCodeLink syncCode="moo-abc-key2" userId="user1" />);

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl2);
    });
    expect(mockToDataURL).toHaveBeenCalledTimes(2);
  });

  it("regenerates QR code when userId changes", async () => {
    const dataUrl1 = "data:image/png;base64,first";
    const dataUrl2 = "data:image/png;base64,second";
    mockToDataURL.mockResolvedValueOnce(dataUrl1).mockResolvedValueOnce(dataUrl2);

    const { rerender } = render(
      <QrCodeLink syncCode="moo-abc-key1" userId="userA" />,
    );

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl1);
    });

    rerender(<QrCodeLink syncCode="moo-abc-key1" userId="userB" />);

    await waitFor(() => {
      expect(screen.getByAltText("掃描此 QR Code 以在手機上開啟墨家書櫃")).toHaveAttribute("src", dataUrl2);
    });
    expect(mockToDataURL).toHaveBeenCalledTimes(2);
  });

  it("shows copy link button", () => {
    mockToDataURL.mockReturnValue(new Promise(() => {}));
    render(<QrCodeLink syncCode="moo-abc-key123" userId="user1" />);
    expect(screen.getByText("複製連結")).toBeInTheDocument();
  });
});
