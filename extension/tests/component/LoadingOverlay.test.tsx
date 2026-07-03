import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LoadingOverlay } from "@/dialog/LoadingOverlay";

describe("LoadingOverlay", () => {
  it("renders the progress message", () => {
    render(<LoadingOverlay message="正在取得帳號資訊..." />);
    expect(screen.getByText("正在取得帳號資訊...")).toBeInTheDocument();
  });

  it("has the loading-overlay test id", () => {
    render(<LoadingOverlay message="載入中..." />);
    expect(screen.getByTestId("loading-overlay")).toBeInTheDocument();
  });

  it("renders different messages", () => {
    const { rerender } = render(<LoadingOverlay message="正在同步書單..." />);
    expect(screen.getByText("正在同步書單...")).toBeInTheDocument();

    rerender(<LoadingOverlay message="完成！" />);
    expect(screen.getByText("完成！")).toBeInTheDocument();
  });

  it("carries the scoped overlay class (fixed/full-screen cover lives in styles.css)", () => {
    // After the Shadow DOM + scoped-CSS conversion the absolute/full-screen cover
    // and z-index rules moved out of inline styles into `.moo-loading-overlay` in
    // styles.css. jsdom does not apply stylesheet rules, so the observable
    // contract that the overlay covers the Dialog content is now the class.
    render(<LoadingOverlay message="載入中..." />);
    const overlay = screen.getByTestId("loading-overlay");
    expect(overlay).toHaveClass("moo-loading-overlay");
  });

  it("spinner carries the scoped spinner class (size/animation live in styles.css)", () => {
    render(<LoadingOverlay message="載入中..." />);
    const overlay = screen.getByTestId("loading-overlay");
    const spinner = overlay.querySelector(".moo-loading-overlay__spinner");
    expect(spinner).toBeInTheDocument();
  });

  it("message carries the scoped message class (color/weight live in styles.css)", () => {
    render(<LoadingOverlay message="正在同步書單..." />);
    const message = screen.getByText("正在同步書單...");
    expect(message).toHaveClass("moo-loading-overlay__message");
  });
});
