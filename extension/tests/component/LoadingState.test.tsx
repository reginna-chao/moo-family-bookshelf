import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LoadingState } from "@/dialog/LoadingState";

describe("LoadingState", () => {
  it("renders the message", () => {
    render(<LoadingState message="載入中..." />);
    expect(screen.getByText("載入中...")).toBeInTheDocument();
  });

  it("renders arbitrary message content", () => {
    render(<LoadingState message="載入家庭書櫃中..." />);
    expect(screen.getByText("載入家庭書櫃中...")).toBeInTheDocument();
  });

  it("has the loading-state test id", () => {
    render(<LoadingState message="test" />);
    expect(screen.getByTestId("loading-state")).toBeInTheDocument();
  });

  it("has a decorative spinner with aria-hidden", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    const spinner = container.querySelector("[aria-hidden='true']");
    expect(spinner).toBeInTheDocument();
  });

  it("carries the scoped container class (flex/centered layout lives in styles.css)", () => {
    // After the Shadow DOM + scoped-CSS conversion the flex/centered layout rules
    // moved out of inline styles into `.moo-loading-state` in styles.css. jsdom
    // does not apply stylesheet rules, so the observable contract is now the class.
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    expect(container).toHaveClass("moo-loading-state");
  });

  it("spinner carries the scoped spinner class (size/animation live in styles.css)", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    const spinner = container.querySelector("[aria-hidden='true']");
    expect(spinner).toHaveClass("moo-loading-state__spinner");
  });

  it("message carries the scoped message class (color/size live in styles.css)", () => {
    render(<LoadingState message="測試訊息" />);
    const message = screen.getByText("測試訊息");
    expect(message).toHaveClass("moo-loading-state__message");
  });

  it("has role status for screen reader announcements", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    expect(container).toHaveAttribute("role", "status");
  });
});
