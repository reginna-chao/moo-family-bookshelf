import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { DialogFooter } from "@/dialog/DialogFooter";
import { useMediaQuery } from "@/hooks/useMediaQuery";

vi.mock("@/hooks/useMediaQuery", () => ({
  useMediaQuery: vi.fn(() => false),
}));

vi.mock("@/utils/appEnv", () => ({
  getAppEnv: vi.fn(() => "prod"),
}));

describe("DialogFooter", () => {
  beforeEach(() => {
    vi.mocked(useMediaQuery).mockReturnValue(false);
  });

  afterEach(async () => {
    const { getAppEnv } = await import("@/utils/appEnv");
    vi.mocked(getAppEnv).mockReturnValue("prod");
  });

  it("renders the disclaimer text", () => {
    render(<DialogFooter />);
    expect(
      screen.getByText("本功能由第三方開發，非 Readmoo 官方提供"),
    ).toBeInTheDocument();
  });

  it("renders the app name and version number", () => {
    render(<DialogFooter />);
    expect(screen.getByText(/墨家書櫃 v0\.1\.0/)).toBeInTheDocument();
  });

  it("has the dialog-footer test id", () => {
    render(<DialogFooter />);
    expect(screen.getByTestId("dialog-footer")).toBeInTheDocument();
  });

  it("renders EnvBadge when env is non-prod", async () => {
    const { getAppEnv } = await import("@/utils/appEnv");
    vi.mocked(getAppEnv).mockReturnValue("dev");

    render(<DialogFooter />);
    expect(screen.getByTestId("env-badge")).toBeInTheDocument();
    expect(screen.getByTestId("env-badge")).toHaveTextContent("DEV");
  });

  it("does not render EnvBadge when env is prod", async () => {
    const { getAppEnv } = await import("@/utils/appEnv");
    vi.mocked(getAppEnv).mockReturnValue("prod");

    render(<DialogFooter />);
    expect(screen.queryByTestId("env-badge")).not.toBeInTheDocument();
  });

  describe("responsive layout", () => {
    it("queries the 576px breakpoint", () => {
      render(<DialogFooter />);
      expect(useMediaQuery).toHaveBeenCalledWith("(min-width: 576px)");
    });

    it("uses narrow column layout below 576px", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer.style.display).not.toBe("flex");
    });

    it("uses wide row layout at 576px and above", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer).toHaveStyle({
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      });
    });

    it("applies flexShrink 0 in narrow mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer.style.flexShrink).toBe("0");
    });

    it("applies flexShrink 0 in wide mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer.style.flexShrink).toBe("0");
    });

    it("applies marginTop to version div in narrow mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const versionDiv = screen.getByText(/墨家書櫃 v0\.1\.0/).closest("div")!;
      expect(versionDiv.style.marginTop).toBe("2px");
    });

    it("does not apply marginTop to version div in wide mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const versionDiv = screen.getByText(/墨家書櫃 v0\.1\.0/).closest("div")!;
      expect(versionDiv.style.marginTop).toBe("");
    });
  });
});
