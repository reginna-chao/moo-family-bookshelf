import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FloatingIconSizeSelector } from "@/dialog/FloatingIconSizeSelector";
import type { FloatingIconSize } from "@/dialog/useFloatingIconSize";

describe("FloatingIconSizeSelector", () => {
  it("renders three buttons with correct aria-labels", () => {
    render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

    expect(screen.getByLabelText("小尺寸")).toBeInTheDocument();
    expect(screen.getByLabelText("中尺寸")).toBeInTheDocument();
    expect(screen.getByLabelText("大尺寸")).toBeInTheDocument();
  });

  it.each<{ current: FloatingIconSize; pressed: string; notPressed: string[] }>([
    { current: "small", pressed: "小尺寸", notPressed: ["中尺寸", "大尺寸"] },
    { current: "medium", pressed: "中尺寸", notPressed: ["小尺寸", "大尺寸"] },
    { current: "large", pressed: "大尺寸", notPressed: ["小尺寸", "中尺寸"] },
  ])("marks $current button as pressed", ({ current, pressed, notPressed }) => {
    render(<FloatingIconSizeSelector size={current} onChange={vi.fn()} />);

    expect(screen.getByLabelText(pressed)).toHaveAttribute("aria-pressed", "true");
    for (const label of notPressed) {
      expect(screen.getByLabelText(label)).toHaveAttribute("aria-pressed", "false");
    }
  });

  it.each<{ label: string; expected: FloatingIconSize }>([
    { label: "小尺寸", expected: "small" },
    { label: "中尺寸", expected: "medium" },
    { label: "大尺寸", expected: "large" },
  ])("calls onChange('$expected') when '$label' is clicked", ({ label, expected }) => {
    const onChange = vi.fn();
    render(<FloatingIconSizeSelector size="medium" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(label));
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it("has a group role with accessible label", () => {
    render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

    expect(screen.getByRole("group", { name: "家庭書櫃按鈕大小" })).toBeInTheDocument();
  });
});
