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
    userId: "user-self",
    value: "all-except-self",
    onChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<MemberDropdown {...defaultProps} />), onChange: defaultProps.onChange };
}

describe("MemberDropdown", () => {
  it("renders fixed options and other members with books", () => {
    renderDropdown();

    const select = screen.getByRole("combobox", { name: "篩選成員" });
    expect(select).toBeInTheDocument();

    // Check all options: all, all-except-self, self, Alice, Bob
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(options[0]).toHaveTextContent("所有人的書");
    expect(options[1]).toHaveTextContent("其他家人的書");
    expect(options[2]).toHaveTextContent("自己的書");
    expect(options[3]).toHaveTextContent("Alice");
    expect(options[4]).toHaveTextContent("Bob");
  });

  it("excludes self from the dynamic member list", () => {
    const members = [
      { userId: "user-self", displayName: "Me", books: [{ bookId: "b0" }] },
      { userId: "user-a", displayName: "Alice", books: [{ bookId: "b1" }] },
    ];
    renderDropdown({ members, userId: "user-self" });

    const options = screen.getAllByRole("option");
    // all, all-except-self, self, Alice (Me should not appear in dynamic list)
    expect(options).toHaveLength(4);
    const optionTexts = options.map((o) => o.textContent);
    expect(optionTexts).not.toContain("Me");
  });

  it("does not show members without books in dynamic list", () => {
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

  it("calls onChange with 'all' when 所有人的書 is selected", () => {
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
    expect(options[3]).toHaveTextContent("abcdefgh");
  });
});
