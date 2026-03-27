import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { StatusFilterBar, StatusFilterBarProps } from "@/dialog/StatusFilterBar";

function renderBar(overrides: Partial<StatusFilterBarProps> = {}) {
  const defaultProps: StatusFilterBarProps = {
    value: "all",
    onChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<StatusFilterBar {...defaultProps} />), onChange: defaultProps.onChange };
}

describe("StatusFilterBar", () => {
  it("renders three filter buttons", () => {
    renderBar();

    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已開放" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "未開放" })).toBeInTheDocument();
  });

  it("calls onChange with 'shared' when 已開放 is clicked", () => {
    const { onChange } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "已開放" }));
    expect(onChange).toHaveBeenCalledWith("shared");
  });

  it("calls onChange with 'not-shared' when 未開放 is clicked", () => {
    const { onChange } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "未開放" }));
    expect(onChange).toHaveBeenCalledWith("not-shared");
  });

  it("calls onChange with 'all' when 全部 is clicked", () => {
    const { onChange } = renderBar({ value: "shared" });

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(onChange).toHaveBeenCalledWith("all");
  });
});
