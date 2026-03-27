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
});
