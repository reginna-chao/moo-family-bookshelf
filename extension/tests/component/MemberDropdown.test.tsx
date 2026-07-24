import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  MemberDropdown,
  MemberDropdownProps,
  HIDDEN_FILTER_VALUE,
  FAVORITE_FILTER_VALUE,
} from "@/dialog/MemberDropdown";

// Alice has 1 book, Bob has 2 books, Carol has none (and no displayName).
const MEMBERS = [
  {
    userId: "user-self",
    displayName: "Me",
    books: [{ bookId: "s1" }, { bookId: "s2" }],
  },
  { userId: "user-a", displayName: "Alice", books: [{ bookId: "b1" }] },
  {
    userId: "user-b",
    displayName: "Bob",
    books: [{ bookId: "b2" }, { bookId: "b3" }],
  },
  { userId: "user-c", displayName: "", books: [] },
];

function renderDropdown(overrides: Partial<MemberDropdownProps> = {}) {
  const defaultProps: MemberDropdownProps = {
    members: MEMBERS,
    userId: "user-self",
    value: "all-except-self",
    onChange: vi.fn(),
    favoriteCount: 4,
    hiddenCount: 3,
    ...overrides,
  };
  return {
    ...render(<MemberDropdown {...defaultProps} />),
    onChange: defaultProps.onChange,
  };
}

/** Open the dropdown and return its listbox element. */
function openMenu(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "篩選成員" }));
  return screen.getByRole("listbox", { name: "成員選單" });
}

describe("MemberDropdown", () => {
  it("renders the current selection label on the closed trigger", () => {
    renderDropdown({ value: "all-except-self" });

    const trigger = screen.getByRole("button", { name: "篩選成員" });
    expect(trigger).toHaveTextContent("其他家人的書");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Menu is not rendered until opened.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("reflects a member value on the trigger when that member is selected", () => {
    renderDropdown({ value: "user-a" });
    expect(screen.getByRole("button", { name: "篩選成員" })).toHaveTextContent(
      "Alice",
    );
  });

  it("opens the listbox when the trigger is clicked", () => {
    renderDropdown();
    const listbox = openMenu();
    expect(listbox).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "篩選成員" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("renders the fixed options in order plus other members with books", () => {
    renderDropdown();
    openMenu();

    const options = screen.getAllByRole("option");
    // all, all-except-self, self, Alice, Bob, favorite, hidden (Carol has no books)
    expect(options).toHaveLength(7);
    expect(options[0]).toHaveTextContent("所有人的書");
    expect(options[1]).toHaveTextContent("其他家人的書");
    expect(options[2]).toHaveTextContent("自己的書");
    expect(options[3]).toHaveTextContent("Alice");
    expect(options[4]).toHaveTextContent("Bob");
    expect(options[5]).toHaveTextContent("我的最愛");
    expect(options[6]).toHaveTextContent("隱藏的書");
  });

  it("marks the option matching value as aria-selected", () => {
    renderDropdown({ value: "user-a" });
    openMenu();

    const alice = screen.getByRole("option", { name: /Alice/ });
    expect(alice).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /所有人的書/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("excludes self and members without books from the dynamic member list", () => {
    renderDropdown();
    openMenu();

    const optionTexts = screen.getAllByRole("option").map((o) => o.textContent);
    // "Me" (self) never appears as a dynamic member; Carol (no books) is omitted.
    expect(optionTexts.some((t) => t?.includes("Me"))).toBe(false);
    expect(optionTexts).not.toContain("user-c");
  });

  it("uses the userId prefix as fallback when a member's displayName is empty", () => {
    const members = [
      { userId: "user-self", displayName: "Me", books: [] },
      {
        userId: "abcdefghijklmnop",
        displayName: "",
        books: [{ bookId: "b1" }],
      },
    ];
    renderDropdown({ members });
    openMenu();

    const options = screen.getAllByRole("option");
    // all, all-except-self, self, <fallback member>, favorite, hidden
    expect(options[3]).toHaveTextContent("abcdefgh");
  });

  describe("option counts (totals, including hidden)", () => {
    // Fixture totals: everyone = 2 (self) + 1 (Alice) + 2 (Bob) + 0 (Carol) = 5;
    // others = 1 + 2 = 3; self = 2; Alice = 1; Bob = 2; favorite/hidden from props.
    const cases: Array<{
      name: string;
      optionLabel: RegExp;
      expected: string;
    }> = [
      {
        name: "all sums every member's books",
        optionLabel: /所有人的書/,
        expected: "5",
      },
      {
        name: "all-except-self sums non-self members",
        optionLabel: /其他家人的書/,
        expected: "3",
      },
      {
        name: "self shows the self member's book count",
        optionLabel: /自己的書/,
        expected: "2",
      },
      {
        name: "each member shows that member's book count",
        optionLabel: /Bob/,
        expected: "2",
      },
      {
        name: "favorite shows the favoriteCount prop",
        optionLabel: /我的最愛/,
        expected: "4",
      },
      {
        name: "hidden shows the hiddenCount prop",
        optionLabel: /隱藏的書/,
        expected: "3",
      },
    ];

    it.each(cases)("$name", ({ optionLabel, expected }) => {
      renderDropdown();
      openMenu();
      const option = screen.getByRole("option", { name: optionLabel });
      const count = option.querySelector(".moo-category__option-count");
      expect(count).not.toBeNull();
      expect(count).toHaveTextContent(expected);
    });
  });

  describe("selection", () => {
    const cases: Array<{
      name: string;
      optionLabel: RegExp;
      expected: string;
    }> = [
      {
        name: "所有人的書 → 'all'",
        optionLabel: /所有人的書/,
        expected: "all",
      },
      {
        name: "其他家人的書 → 'all-except-self'",
        optionLabel: /其他家人的書/,
        expected: "all-except-self",
      },
      {
        name: "自己的書 → userId",
        optionLabel: /自己的書/,
        expected: "user-self",
      },
      {
        name: "a member → that member's userId",
        optionLabel: /Alice/,
        expected: "user-a",
      },
      {
        name: "我的最愛 → favorite sentinel",
        optionLabel: /我的最愛/,
        expected: FAVORITE_FILTER_VALUE,
      },
      {
        name: "隱藏的書 → hidden sentinel",
        optionLabel: /隱藏的書/,
        expected: HIDDEN_FILTER_VALUE,
      },
    ];

    it.each(cases)(
      "selecting %s calls onChange with the right value",
      ({ optionLabel, expected }) => {
        const { onChange } = renderDropdown();
        openMenu();
        fireEvent.click(screen.getByRole("option", { name: optionLabel }));
        expect(onChange).toHaveBeenCalledWith(expected);
      },
    );

    it("closes the menu after an option is selected", () => {
      renderDropdown();
      const listbox = openMenu();
      fireEvent.click(
        within(listbox).getByRole("option", { name: /所有人的書/ }),
      );
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  describe("outside-click dismissal", () => {
    it("closes the menu on an outside mousedown", () => {
      renderDropdown();
      openMenu();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("keeps the menu open on a mousedown inside the popover", () => {
      renderDropdown();
      const listbox = openMenu();
      fireEvent.mouseDown(listbox);
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("removes the document mousedown listener when unmounted while open", () => {
      const removeSpy = vi.spyOn(document, "removeEventListener");
      const { unmount } = renderDropdown();
      openMenu();
      unmount();
      expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function));
      removeSpy.mockRestore();
    });
  });
});
