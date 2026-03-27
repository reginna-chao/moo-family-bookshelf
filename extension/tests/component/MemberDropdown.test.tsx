import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemberDropdown, MemberDropdownProps } from "@/dialog/MemberDropdown";

const MEMBERS = [
  { userId: "user-a", displayName: "Alice", books: [{ bookId: "b1" }] },
  { userId: "user-b", displayName: "Bob", books: [{ bookId: "b2" }] },
  { userId: "user-c", displayName: "", books: [] },
];

function renderDropdown(overrides: Partial<MemberDropdownProps> = {}) {
  const defaultProps: MemberDropdownProps = {
    members: MEMBERS,
    value: "all-except-self",
    onChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<MemberDropdown {...defaultProps} />), onChange: defaultProps.onChange };
}

describe("MemberDropdown", () => {
  it("renders default options and members with books", () => {
    renderDropdown();

    const select = screen.getByRole("combobox", { name: "篩選成員" });
    expect(select).toBeInTheDocument();

    // Check all options
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(4); // all-except-self, all, Alice, Bob
    expect(options[0]).toHaveTextContent("全部（不含自己）");
    expect(options[1]).toHaveTextContent("全部");
    expect(options[2]).toHaveTextContent("Alice");
    expect(options[3]).toHaveTextContent("Bob");
  });

  it("does not show members without books", () => {
    renderDropdown();
    // user-c has no books and no displayName
    const options = screen.getAllByRole("option");
    const optionTexts = options.map((o) => o.textContent);
    expect(optionTexts).not.toContain("user-c");
  });

  it("calls onChange when selection changes", () => {
    const { onChange } = renderDropdown();

    const select = screen.getByRole("combobox", { name: "篩選成員" });
    fireEvent.change(select, { target: { value: "user-a" } });

    expect(onChange).toHaveBeenCalledWith("user-a");
  });

  it("calls onChange with 'all' when 全部 is selected", () => {
    const { onChange } = renderDropdown();

    const select = screen.getByRole("combobox", { name: "篩選成員" });
    fireEvent.change(select, { target: { value: "all" } });

    expect(onChange).toHaveBeenCalledWith("all");
  });

  it("uses userId prefix as fallback for empty displayName", () => {
    const members = [
      { userId: "abcdefghijklmnop", displayName: "", books: [{ bookId: "b1" }] },
    ];
    renderDropdown({ members });

    const options = screen.getAllByRole("option");
    // The member option should show first 8 chars of userId
    expect(options[2]).toHaveTextContent("abcdefgh");
  });
});
