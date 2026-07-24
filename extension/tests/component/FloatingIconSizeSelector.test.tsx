import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FloatingIconSizeSelector } from "@/dialog/FloatingIconSizeSelector";
import type { FloatingIconSize } from "@/dialog/useFloatingIconSize";

describe("FloatingIconSizeSelector", () => {
  it("renders four buttons with correct aria-labels", () => {
    render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

    expect(screen.getByLabelText("僅圖示")).toBeInTheDocument();
    expect(screen.getByLabelText("小尺寸")).toBeInTheDocument();
    expect(screen.getByLabelText("中尺寸")).toBeInTheDocument();
    expect(screen.getByLabelText("大尺寸")).toBeInTheDocument();
  });

  it.each<{ current: FloatingIconSize; pressed: string; notPressed: string[] }>(
    [
      {
        current: "icon",
        pressed: "僅圖示",
        notPressed: ["小尺寸", "中尺寸", "大尺寸"],
      },
      {
        current: "small",
        pressed: "小尺寸",
        notPressed: ["僅圖示", "中尺寸", "大尺寸"],
      },
      {
        current: "medium",
        pressed: "中尺寸",
        notPressed: ["僅圖示", "小尺寸", "大尺寸"],
      },
      {
        current: "large",
        pressed: "大尺寸",
        notPressed: ["僅圖示", "小尺寸", "中尺寸"],
      },
    ],
  )("marks $current button as pressed", ({ current, pressed, notPressed }) => {
    render(<FloatingIconSizeSelector size={current} onChange={vi.fn()} />);

    expect(screen.getByLabelText(pressed)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const label of notPressed) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it.each<{ label: string; expected: FloatingIconSize }>([
    { label: "僅圖示", expected: "icon" },
    { label: "小尺寸", expected: "small" },
    { label: "中尺寸", expected: "medium" },
    { label: "大尺寸", expected: "large" },
  ])(
    "calls onChange('$expected') when '$label' is clicked",
    ({ label, expected }) => {
      const onChange = vi.fn();
      render(<FloatingIconSizeSelector size="medium" onChange={onChange} />);

      fireEvent.click(screen.getByLabelText(label));
      expect(onChange).toHaveBeenCalledWith(expected);
    },
  );

  it("has a group role with accessible label", () => {
    render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

    expect(
      screen.getByRole("group", { name: "家庭書櫃按鈕大小" }),
    ).toBeInTheDocument();
  });

  // The segmented-control container clip (overflow: hidden) and per-segment
  // corner radii moved from inline styles into the shadow-scoped
  // `.moo-icon-size` / `.moo-icon-size__segment--{first,middle,last}` classes in
  // styles.css. jsdom does not apply stylesheet rules, so the observable
  // contract is the class list, not computed inline styles.
  it("carries the segmented-container class that clips child corners", () => {
    render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

    const container = screen.getByRole("group", { name: "家庭書櫃按鈕大小" });
    expect(container).toHaveClass("moo-icon-size");
  });

  it.each<{ label: string; position: string }>([
    { label: "僅圖示", position: "first" },
    { label: "小尺寸", position: "middle" },
    { label: "中尺寸", position: "middle" },
    { label: "大尺寸", position: "last" },
  ])(
    "tags the '$label' segment with the --$position corner modifier",
    ({ label, position }) => {
      render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

      const segment = screen.getByLabelText(label);
      expect(segment).toHaveClass("moo-icon-size__segment");
      expect(segment).toHaveClass(`moo-icon-size__segment--${position}`);
    },
  );

  it.each<{ current: FloatingIconSize; active: string; inactive: string[] }>([
    {
      current: "icon",
      active: "僅圖示",
      inactive: ["小尺寸", "中尺寸", "大尺寸"],
    },
    {
      current: "small",
      active: "小尺寸",
      inactive: ["僅圖示", "中尺寸", "大尺寸"],
    },
    {
      current: "medium",
      active: "中尺寸",
      inactive: ["僅圖示", "小尺寸", "大尺寸"],
    },
    {
      current: "large",
      active: "大尺寸",
      inactive: ["僅圖示", "小尺寸", "中尺寸"],
    },
  ])(
    "highlights only the selected '$current' segment with the --active modifier",
    ({ current, active, inactive }) => {
      render(<FloatingIconSizeSelector size={current} onChange={vi.fn()} />);

      expect(screen.getByLabelText(active)).toHaveClass(
        "moo-icon-size__segment--active",
      );
      for (const label of inactive) {
        expect(screen.getByLabelText(label)).not.toHaveClass(
          "moo-icon-size__segment--active",
        );
      }
    },
  );

  // The borders / hover fill / focus ring / corner radii were folded into the
  // shared `.moo-segmented__item` component class; `.moo-icon-size__segment`
  // now only adds `flex: 1`. jsdom does not apply the stylesheet, so the class
  // list is the contract that keeps the shared base from being dropped.
  it.each<{ label: string; position: string }>([
    { label: "僅圖示", position: "first" },
    { label: "小尺寸", position: "middle" },
    { label: "中尺寸", position: "middle" },
    { label: "大尺寸", position: "last" },
  ])(
    "opts the '$label' segment into the shared segmented-item base",
    ({ label, position }) => {
      render(<FloatingIconSizeSelector size="medium" onChange={vi.fn()} />);

      const segment = screen.getByLabelText(label);
      expect(segment).toHaveClass("moo-segmented__item");
      expect(segment).toHaveClass(`moo-segmented__item--${position}`);
    },
  );
});
