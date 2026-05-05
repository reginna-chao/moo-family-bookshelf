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

  it("applies flex column centered layout", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    expect(container).toHaveStyle({
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    });
  });

  it("applies minHeight 240 as fallback for non-flex parents", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    expect(container.style.minHeight).toBe("240px");
  });

  it("has role status for screen reader announcements", () => {
    render(<LoadingState message="test" />);
    const container = screen.getByTestId("loading-state");
    expect(container).toHaveAttribute("role", "status");
  });
});
