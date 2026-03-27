import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { DialogFooter } from "@/dialog/DialogFooter";
import { reportLinks } from "@/config/links";

describe("DialogFooter", () => {
  it("renders the disclaimer text", () => {
    render(<DialogFooter />);
    expect(
      screen.getByText("本功能由第三方開發，非 Readmoo 官方提供"),
    ).toBeInTheDocument();
  });

  it("renders the version number", () => {
    render(<DialogFooter />);
    expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument();
  });

  it("renders all report links in full mode", () => {
    render(<DialogFooter />);
    for (const link of reportLinks) {
      const anchor = screen.getByTitle(link.name);
      expect(anchor).toBeInTheDocument();
      expect(anchor).toHaveAttribute("href", link.url);
      expect(anchor).toHaveAttribute("target", "_blank");
      expect(anchor).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("does not render report links in minimal mode", () => {
    render(<DialogFooter minimal />);
    for (const link of reportLinks) {
      expect(screen.queryByTitle(link.name)).not.toBeInTheDocument();
    }
  });

  it("renders disclaimer and version in minimal mode", () => {
    render(<DialogFooter minimal />);
    expect(
      screen.getByText("本功能由第三方開發，非 Readmoo 官方提供"),
    ).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("has the dialog-footer test id", () => {
    render(<DialogFooter />);
    expect(screen.getByTestId("dialog-footer")).toBeInTheDocument();
  });
});
