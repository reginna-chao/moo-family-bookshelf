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
    expect(screen.getByText(/墨家書櫃 v\d+\.\d+\.\d+/)).toBeInTheDocument();
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

    // jsdom applies no stylesheet, so classes are the contract: row layout `.moo-footer--wide`, version
    // `.moo-footer__version`, flexShrink on base `.moo-footer` (both breakpoints — always present).
    it("uses narrow column layout below 576px (no --wide modifier)", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer).toHaveClass("moo-footer");
      expect(footer).not.toHaveClass("moo-footer--wide");
    });

    it("uses wide row layout at 576px and above (adds --wide modifier)", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer).toHaveClass("moo-footer");
      expect(footer).toHaveClass("moo-footer--wide");
    });

    it("carries the base moo-footer class (flexShrink 0) in narrow mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer).toHaveClass("moo-footer");
    });

    it("carries the base moo-footer class (flexShrink 0) in wide mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const footer = screen.getByTestId("dialog-footer");
      expect(footer).toHaveClass("moo-footer");
    });

    it("applies the version class (marginTop) in narrow mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(false);
      render(<DialogFooter />);
      const versionDiv = screen
        .getByText(/墨家書櫃 v\d+\.\d+\.\d+/)
        .closest("div")!;
      expect(versionDiv).toHaveClass("moo-footer__version");
    });

    it("does not apply the version class (marginTop) in wide mode", () => {
      vi.mocked(useMediaQuery).mockReturnValue(true);
      render(<DialogFooter />);
      const versionDiv = screen
        .getByText(/墨家書櫃 v\d+\.\d+\.\d+/)
        .closest("div")!;
      expect(versionDiv).not.toHaveClass("moo-footer__version");
    });
  });
});
