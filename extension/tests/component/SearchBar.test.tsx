import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SearchBar, SearchBarProps } from "@/dialog/SearchBar";
import { useIsMobile } from "@/hooks/useIsMobile";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

function renderSearchBar(overrides: Partial<SearchBarProps> = {}) {
  const defaultProps: SearchBarProps = {
    value: "",
    onChange: vi.fn(),
    totalCount: 10,
    filteredCount: 3,
    isFiltering: false,
  };
  const props = { ...defaultProps, ...overrides };
  return { ...render(<SearchBar {...props} />), props };
}

describe("SearchBar", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("renders input with correct placeholder", () => {
    renderSearchBar();
    const input = screen.getByPlaceholderText("搜尋書名或作者...");
    expect(input).toBeDefined();
  });

  it("renders input with correct aria-label", () => {
    renderSearchBar();
    const input = screen.getByLabelText("搜尋書名或作者");
    expect(input).toBeDefined();
  });

  it("displays the current value", () => {
    renderSearchBar({ value: "React" });
    const input = screen.getByDisplayValue("React");
    expect(input).toBeDefined();
  });

  it("calls onChange when user types", () => {
    const onChange = vi.fn();
    renderSearchBar({ onChange });
    const input = screen.getByPlaceholderText("搜尋書名或作者...");
    fireEvent.change(input, { target: { value: "test" } });
    expect(onChange).toHaveBeenCalledWith("test");
  });

  it("does not show count when isFiltering is false", () => {
    renderSearchBar({ isFiltering: false });
    expect(screen.queryByTestId("search-count")).toBeNull();
  });

  it("shows filtered count when isFiltering is true", () => {
    renderSearchBar({ isFiltering: true, filteredCount: 3, totalCount: 10 });
    const countEl = screen.getByTestId("search-count");
    expect(countEl.textContent).toBe("顯示 3 / 10 本");
  });

  it("shows 0 filtered count correctly", () => {
    renderSearchBar({ isFiltering: true, filteredCount: 0, totalCount: 5 });
    const countEl = screen.getByTestId("search-count");
    expect(countEl.textContent).toBe("顯示 0 / 5 本");
  });

  describe("responsive sizing", () => {
    it("uses a 32px-tall input on mobile", () => {
      vi.mocked(useIsMobile).mockReturnValue(true);
      renderSearchBar();
      const input = screen.getByLabelText("搜尋書名或作者");
      expect(input.style.height).toBe("32px");
    });

    it("does not pin the input height on desktop", () => {
      vi.mocked(useIsMobile).mockReturnValue(false);
      renderSearchBar();
      const input = screen.getByLabelText("搜尋書名或作者");
      expect(input.style.height).toBe("");
    });
  });
});
