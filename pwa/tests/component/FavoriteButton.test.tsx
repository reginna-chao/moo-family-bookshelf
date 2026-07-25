import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { FavoriteButton } from "@/components/FavoriteButton";

describe("FavoriteButton (PWA)", () => {
  it("renders a hollow heart with 加入最愛 label when not favorited", () => {
    render(<FavoriteButton isFavorite={false} onFavoriteToggle={() => {}} />);

    const btn = screen.getByRole("button", { name: "加入最愛" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("title", "加入最愛");
    // Hollow: the svg is not filled.
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
    // Grey (not favorited) uses a gray text class, not the filled red one.
    expect(btn.className).toContain("text-gray-400");
    expect(btn.className).not.toContain("text-red-500");
  });

  it("renders a filled red heart with 取消最愛 label when favorited", () => {
    render(<FavoriteButton isFavorite={true} onFavoriteToggle={() => {}} />);

    const btn = screen.getByRole("button", { name: "取消最愛" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAttribute("title", "取消最愛");
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(btn.className).toContain("text-red-500");
  });

  it("is a type=button so it never submits an enclosing form", () => {
    render(<FavoriteButton isFavorite={false} onFavoriteToggle={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("calls onFavoriteToggle when clicked", () => {
    const onFavoriteToggle = vi.fn();
    render(
      <FavoriteButton isFavorite={false} onFavoriteToggle={onFavoriteToggle} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入最愛" }));
    expect(onFavoriteToggle).toHaveBeenCalledTimes(1);
  });

  it("prevents default and stops propagation so the wrapping link does not navigate", () => {
    const onFavoriteToggle = vi.fn();
    const onLinkClick = vi.fn();
    render(
      <a href="https://readmoo.com/x" onClick={onLinkClick}>
        <FavoriteButton
          isFavorite={false}
          onFavoriteToggle={onFavoriteToggle}
        />
      </a>,
    );

    const result = fireEvent.click(
      screen.getByRole("button", { name: "加入最愛" }),
    );

    expect(result).toBe(false);
    expect(onLinkClick).not.toHaveBeenCalled();
    expect(onFavoriteToggle).toHaveBeenCalledTimes(1);
  });
});
