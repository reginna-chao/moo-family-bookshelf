import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { DialogFooter } from "@/dialog/DialogFooter";

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock("@/utils/appEnv", () => ({
  getAppEnv: vi.fn(() => "prod"),
}));

describe("DialogFooter", () => {
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
});
