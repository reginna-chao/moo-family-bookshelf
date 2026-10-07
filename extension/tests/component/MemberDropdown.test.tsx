import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import {
  MemberDropdown,
  MemberDropdownProps,
  HIDDEN_FILTER_VALUE,
  FAVORITE_FILTER_VALUE,
  type MemberFilterValue,
} from "@/dialog/MemberDropdown";
import { familyPrefRef } from "moo-family-bookshelf-shared/familyShelf/prefRefs";
import {
  memberFilterTrigger,
  menuOptionCount,
  optionCount,
  triggerCount,
} from "./helpers/memberFilter";

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
    hiddenRefs: new Set<string>(),
    ...overrides,
  };
  return {
    ...render(<MemberDropdown {...defaultProps} />),
    onChange: defaultProps.onChange,
  };
}

/** Owns `value` the way FamilyShelf does, so a click really switches scope. */
function StatefulDropdown({ initial }: { initial: MemberFilterValue }) {
  const [value, setValue] = useState<MemberFilterValue>(initial);
  return (
    <MemberDropdown
      members={MEMBERS}
      userId="user-self"
      value={value}
      onChange={setValue}
      favoriteCount={4}
      hiddenCount={3}
      hiddenRefs={new Set<string>()}
    />
  );
}

/** Open the dropdown and return its listbox element. */
function openMenu(): HTMLElement {
  fireEvent.click(memberFilterTrigger());
  return screen.getByRole("listbox", { name: "成員選單" });
}

describe("MemberDropdown", () => {
  it("renders the current selection label on the closed trigger", () => {
    renderDropdown({ value: "all-except-self" });

    const trigger = memberFilterTrigger();
    expect(trigger).toHaveTextContent("其他家人的書");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Menu is not rendered until opened.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("reflects a member value on the trigger when that member is selected", () => {
    renderDropdown({ value: "user-a" });
    expect(memberFilterTrigger()).toHaveTextContent("Alice");
  });

  it("opens the listbox when the trigger is clicked", () => {
    renderDropdown();
    const listbox = openMenu();
    expect(listbox).toBeInTheDocument();
    expect(memberFilterTrigger()).toHaveAttribute("aria-expanded", "true");
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

  describe("option counts (nothing hidden)", () => {
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
      expect(optionCount(option)).toBe(expected);
    });
  });

  describe("trigger count", () => {
    it("shows the selected scope's count on the collapsed trigger", () => {
      renderDropdown({ value: "all-except-self" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveTextContent("其他家人的書");
      expect(triggerCount()).toBe("3");
    });

    it("keeps the separator out of the accessibility tree and names the trigger by its label and count", () => {
      renderDropdown();
      const sep = within(memberFilterTrigger()).getByText("·");
      expect(sep).toHaveAttribute("aria-hidden", "true");
      // Positive companion: the aria-label carries the label and count, not "·".
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，3 本",
      );
    });

    // Trigger and menu must show the same number for the same option.
    it.each<{ value: MemberFilterValue; expected: string }>([
      { value: "all", expected: "5" },
      { value: "all-except-self", expected: "3" },
      { value: "user-self", expected: "2" },
      { value: "user-a", expected: "1" },
      { value: FAVORITE_FILTER_VALUE, expected: "4" },
      { value: HIDDEN_FILTER_VALUE, expected: "3" },
    ])(
      "shows $expected on the trigger for $value, equal to the selected option's menu count",
      ({ value, expected }) => {
        renderDropdown({ value });
        expect(triggerCount()).toBe(expected);

        fireEvent.click(memberFilterTrigger());
        const selected = screen
          .getAllByRole("option")
          .find((o) => o.getAttribute("aria-selected") === "true");
        if (!selected) throw new Error("no selected option");
        expect(optionCount(selected)).toBe(expected);
      },
    );

    it("updates the trigger count when the user switches to 自己的書", () => {
      render(<StatefulDropdown initial="all-except-self" />);
      expect(triggerCount()).toBe("3");

      fireEvent.click(memberFilterTrigger());
      fireEvent.click(screen.getByRole("option", { name: /自己的書/ }));

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveTextContent("自己的書");
      expect(triggerCount()).toBe("2");
    });
  });

  // The aria-label replaces the button text for assistive tech, so it announces the trigger's label and
  // count. Literals pin production copy (memberFilterAccessibleName in shared/src/familyShelf/).
  describe("trigger accessible name", () => {
    it("announces the default selection's label and count, not the bare prefix", () => {
      renderDropdown({ value: "all-except-self" });
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，3 本",
      );
      // Sibling variant: the old static name must be gone.
      expect(memberFilterTrigger()).not.toHaveAccessibleName("篩選成員");
    });

    it.each<{ value: MemberFilterValue; expected: string }>([
      { value: "all", expected: "篩選成員：所有人的書，5 本" },
      { value: "user-self", expected: "篩選成員：自己的書，2 本" },
      { value: "user-a", expected: "篩選成員：Alice，1 本" },
      { value: FAVORITE_FILTER_VALUE, expected: "篩選成員：我的最愛，4 本" },
      { value: HIDDEN_FILTER_VALUE, expected: "篩選成員：隱藏的書，3 本" },
    ])("is exactly $expected for $value", ({ value, expected }) => {
      renderDropdown({ value });
      expect(memberFilterTrigger()).toHaveAccessibleName(expected);
    });

    it("announces a 0 count as 0 本", () => {
      renderDropdown({ value: HIDDEN_FILTER_VALUE, hiddenCount: 0 });
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：隱藏的書，0 本",
      );
    });

    it("follows the user's selection to the new label and count", () => {
      render(<StatefulDropdown initial="all-except-self" />);
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，3 本",
      );

      fireEvent.click(memberFilterTrigger());
      fireEvent.click(screen.getByRole("option", { name: /自己的書/ }));
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：自己的書，2 本",
      );

      fireEvent.click(memberFilterTrigger());
      fireEvent.click(screen.getByRole("option", { name: /我的最愛/ }));
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：我的最愛，4 本",
      );
    });

    it("drops the announced count by 1, in step with the visible count, when a book in scope is hidden", () => {
      const { rerender } = renderDropdown({
        value: "all-except-self",
        hiddenCount: 0,
      });
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，3 本",
      );

      rerender(
        <MemberDropdown
          members={MEMBERS}
          userId="user-self"
          value="all-except-self"
          onChange={vi.fn()}
          favoriteCount={4}
          hiddenCount={1}
          hiddenRefs={new Set([familyPrefRef("user-b", "b2")])}
        />,
      );

      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，2 本",
      );
      expect(triggerCount()).toBe("2");
    });
  });

  describe("hidden books", () => {
    // Hide Bob's b2 and the viewer's s1; Alice's only book b1 stays visible.
    const HIDDEN = new Set([
      familyPrefRef("user-b", "b2"),
      familyPrefRef("user-self", "s1"),
    ]);

    it.each<{ label: string; expected: string }>([
      { label: "所有人的書", expected: "3" },
      { label: "其他家人的書", expected: "2" },
      { label: "自己的書", expected: "1" },
      { label: "Alice", expected: "1" },
      { label: "Bob", expected: "1" },
      // Favorite / hidden come from their props, untouched by hiddenRefs.
      { label: "我的最愛", expected: "4" },
      { label: "隱藏的書", expected: "2" },
    ])("leaves hidden books out of the $label count", ({ label, expected }) => {
      renderDropdown({ hiddenRefs: HIDDEN, hiddenCount: 2 });
      expect(menuOptionCount(label)).toBe(expected);
    });

    it("lowers the trigger and the selected option by 1 when a book in scope is hidden", () => {
      const { rerender } = renderDropdown({
        value: "all-except-self",
        hiddenCount: 0,
      });
      expect(triggerCount()).toBe("3");
      expect(menuOptionCount("其他家人的書")).toBe("3");
      expect(menuOptionCount("隱藏的書")).toBe("0");

      rerender(
        <MemberDropdown
          members={MEMBERS}
          userId="user-self"
          value="all-except-self"
          onChange={vi.fn()}
          favoriteCount={4}
          hiddenCount={1}
          hiddenRefs={new Set([familyPrefRef("user-b", "b2")])}
        />,
      );

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(triggerCount()).toBe("2");
      expect(menuOptionCount("其他家人的書")).toBe("2");
      expect(menuOptionCount("Bob")).toBe("1");
      expect(menuOptionCount("隱藏的書")).toBe("1");
    });

    it("keeps a member whose every book is hidden in the list, with a 0 count", () => {
      renderDropdown({
        hiddenRefs: new Set([familyPrefRef("user-a", "b1")]),
        hiddenCount: 1,
      });
      expect(menuOptionCount("Alice")).toBe("0");
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

  // The focused option unmounts with the menu; without a focus move keyboard / screen-reader users land
  // on <body>. Assert on the trigger itself (in production's shadow root activeElement is the host).
  describe("focus return", () => {
    it("moves focus to the trigger after an option is chosen, which then names the new scope", () => {
      render(<StatefulDropdown initial="all-except-self" />);
      openMenu();
      const option = screen.getByRole("option", { name: /自己的書/ });
      option.focus();
      expect(option).toHaveFocus();

      fireEvent.click(option);

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveFocus();
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：自己的書，2 本",
      );
    });

    it("moves focus to the trigger when the menu is closed with Escape", () => {
      renderDropdown();
      openMenu();
      const option = screen.getByRole("option", { name: /所有人的書/ });
      option.focus();
      expect(option).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveFocus();
    });

    it("leaves focus on the outside element when the menu is closed by an outside mousedown", () => {
      render(
        <div>
          <button type="button">outside</button>
          <MemberDropdown
            members={MEMBERS}
            userId="user-self"
            value="all-except-self"
            onChange={vi.fn()}
            favoriteCount={4}
            hiddenCount={3}
            hiddenRefs={new Set<string>()}
          />
        </div>,
      );
      openMenu();
      const outside = screen.getByRole("button", { name: "outside" });
      outside.focus();

      fireEvent.mouseDown(outside);

      // Positive companion: the mousedown did dismiss the menu.
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(outside).toHaveFocus();
      expect(memberFilterTrigger()).not.toHaveFocus();
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
