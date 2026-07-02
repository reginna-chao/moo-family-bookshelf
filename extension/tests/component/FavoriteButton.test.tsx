import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { FavoriteButton } from "@/dialog/FavoriteButton";

describe("FavoriteButton (Extension)", () => {
  it("renders a hollow heart with 加入最愛 label when not favorited", () => {
    render(<FavoriteButton isFavorite={false} onFavoriteToggle={() => {}} />);

    const btn = screen.getByRole("button", { name: "加入最愛" });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("title", "加入最愛");
    // Hollow: the svg is not filled.
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });

  it("renders a filled red heart with 取消最愛 label when favorited", () => {
    render(<FavoriteButton isFavorite={true} onFavoriteToggle={() => {}} />);

    const btn = screen.getByRole("button", { name: "取消最愛" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveAttribute("title", "取消最愛");
    // Filled: the svg uses currentColor (red) as fill.
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(btn.style.color).toBe("rgb(239, 68, 68)");
  });

  it("is a type=button so it never submits an enclosing form", () => {
    render(<FavoriteButton isFavorite={false} onFavoriteToggle={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("calls onFavoriteToggle when clicked", () => {
    const onFavoriteToggle = vi.fn();
    render(<FavoriteButton isFavorite={false} onFavoriteToggle={onFavoriteToggle} />);

    fireEvent.click(screen.getByRole("button", { name: "加入最愛" }));
    expect(onFavoriteToggle).toHaveBeenCalledTimes(1);
  });

  it("prevents default and stops propagation so the wrapping link does not navigate", () => {
    const onFavoriteToggle = vi.fn();
    const onLinkClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/anchor-is-valid
      <a href="https://readmoo.com/x" onClick={onLinkClick}>
        <FavoriteButton isFavorite={false} onFavoriteToggle={onFavoriteToggle} />
      </a>,
    );

    const result = fireEvent.click(screen.getByRole("button", { name: "加入最愛" }));

    // defaultPrevented → fireEvent.click returns false.
    expect(result).toBe(false);
    // Propagation stopped → the anchor's handler never fires.
    expect(onLinkClick).not.toHaveBeenCalled();
    expect(onFavoriteToggle).toHaveBeenCalledTimes(1);
  });
});
