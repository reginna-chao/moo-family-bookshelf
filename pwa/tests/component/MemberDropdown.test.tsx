import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import React, { useState } from "react";
import { MemberDropdown } from "@/components/MemberDropdown";
import {
  FAVORITE_FILTER_VALUE,
  HIDDEN_FILTER_VALUE,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import { BoolFlag, type BookEntry } from "@/api/client";
import { familyPrefRef } from "moo-family-bookshelf-shared/familyShelf/prefRefs";
import {
  memberFilterTrigger,
  menuOptionCount,
  optionCount,
  triggerCount,
} from "./helpers/memberFilter";

afterEach(cleanup);

const SELF_ID = "user-self";
const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

/** Minimal book stubs with ids b0..b{n-1} (hidden refs key on `bookId`). */
function books(n: number): BookEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    bookId: `b${i}`,
    title: `Book ${i}`,
    author: "",
    isbn: "",
    coverUrl: "",
    readmooUrl: "",
    category: "",
    isShared: BoolFlag.TRUE,
  }));
}

const members: MemberBooks[] = [
  { userId: SELF_ID, displayName: "我", books: books(2) },
  { userId: ALICE_ID, displayName: "Alice", books: books(3) },
  { userId: BOB_ID, displayName: "Bob", books: books(0) }, // no books → excluded from per-member options
];

interface RenderArgs {
  value?: MemberFilterValue;
  onChange?: (value: MemberFilterValue) => void;
  favoriteCount?: number;
  hiddenCount?: number;
  hiddenRefs?: ReadonlySet<string>;
}

function dropdownElement({
  value = "all",
  onChange = vi.fn(),
  favoriteCount = 5,
  hiddenCount = 4,
  hiddenRefs = new Set<string>(),
}: RenderArgs = {}) {
  return (
    <MemberDropdown
      members={members}
      userId={SELF_ID}
      value={value}
      onChange={onChange}
      favoriteCount={favoriteCount}
      hiddenCount={hiddenCount}
      hiddenRefs={hiddenRefs}
    />
  );
}

function renderDropdown(args: RenderArgs = {}) {
  return render(dropdownElement(args));
}

/** Owns `value` the way FamilyShelfPage does, so a click really switches scope. */
function StatefulDropdown({ initial }: { initial: MemberFilterValue }) {
  const [value, setValue] = useState<MemberFilterValue>(initial);
  return dropdownElement({ value, onChange: setValue });
}

function openListbox(): HTMLElement {
  fireEvent.click(memberFilterTrigger());
  return screen.getByRole("listbox", { name: "成員選單" });
}

describe("MemberDropdown", () => {
  it("shows the label of the currently selected option on the trigger", () => {
    renderDropdown({ value: SELF_ID });
    const trigger = memberFilterTrigger();
    expect(trigger).toHaveTextContent("自己的書");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("falls back to the first option's label when value matches no option", () => {
    renderDropdown({ value: "unknown-user" });
    expect(memberFilterTrigger()).toHaveTextContent("所有人的書");
  });

  it("lists options in the fixed order with correct counts, excluding members with no books", () => {
    // favoriteCount / hiddenCount come from props, not from member books.
    renderDropdown({ value: "all", favoriteCount: 5, hiddenCount: 4 });
    const listbox = openListbox();
    const options = within(listbox).getAllByRole("option");

    // all(5) / all-except-self(3) / self(2) / Alice(3) / favorite(5) / hidden(4).
    // Bob has 0 books → not listed as a per-member option.
    const expected: Array<{ label: string; count: string }> = [
      { label: "所有人的書", count: "5" }, // 2 + 3 + 0
      { label: "其他家人的書", count: "3" }, // Alice 3 + Bob 0
      { label: "自己的書", count: "2" },
      { label: "Alice", count: "3" },
      { label: "我的最愛", count: "5" }, // from favoriteCount prop
      { label: "隱藏的書", count: "4" }, // from hiddenCount prop
    ];

    expect(options).toHaveLength(expected.length);
    options.forEach((opt, i) => {
      expect(opt).toHaveTextContent(expected[i].label);
      expect(optionCount(opt)).toBe(expected[i].count);
    });
    // Bob is never rendered as an option.
    expect(within(listbox).queryByText("Bob")).not.toBeInTheDocument();
  });

  it("marks the option matching value as selected", () => {
    renderDropdown({ value: ALICE_ID });
    const listbox = openListbox();
    const selected = within(listbox)
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveTextContent("Alice");
  });

  it.each<{ name: string; label: string; expected: MemberFilterValue }>([
    { name: "all", label: "所有人的書", expected: "all" },
    {
      name: "all-except-self",
      label: "其他家人的書",
      expected: "all-except-self",
    },
    { name: "self", label: "自己的書", expected: SELF_ID },
    { name: "other member", label: "Alice", expected: ALICE_ID },
    {
      name: "favorite sentinel",
      label: "我的最愛",
      expected: FAVORITE_FILTER_VALUE,
    },
    {
      name: "hidden sentinel",
      label: "隱藏的書",
      expected: HIDDEN_FILTER_VALUE,
    },
  ])(
    "calls onChange with the $name value and closes when its option is clicked",
    ({ label, expected }) => {
      const onChange = vi.fn();
      renderDropdown({ value: "all", onChange });
      const listbox = openListbox();

      const option = within(listbox)
        .getAllByRole("option")
        .find((o) => o.textContent?.startsWith(label));
      if (!option) throw new Error(`option not found: ${label}`);
      fireEvent.click(option);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(expected);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    },
  );

  it("closes the popover on an outside mousedown", () => {
    render(
      <div>
        <button>outside</button>
        <MemberDropdown
          members={members}
          userId={SELF_ID}
          value="all"
          onChange={vi.fn()}
          favoriteCount={0}
          hiddenCount={0}
          hiddenRefs={new Set<string>()}
        />
      </div>,
    );

    fireEvent.click(memberFilterTrigger());
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the popover on Escape", () => {
    renderDropdown();

    openListbox();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(memberFilterTrigger()).toHaveAttribute("aria-expanded", "false");
  });

  // Inline popover: it scrolls along with its trigger, and mobile address-bar
  // collapse fires resize, so neither may dismiss it.
  it("stays open on page scroll and window resize", () => {
    renderDropdown();

    openListbox();
    fireEvent.scroll(window);
    fireEvent.scroll(document);
    fireEvent(window, new Event("resize"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Positive companion: the dismissal listeners are live — Escape still works.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes when the trigger is pressed again (mousedown on the trigger is not an outside click)", () => {
    renderDropdown();

    openListbox();
    const trigger = memberFilterTrigger();
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  // The focused option unmounts with the menu; without an explicit focus move a
  // keyboard / screen-reader user would be dropped on <body>.
  describe("focus return", () => {
    function focusOption(listbox: HTMLElement, label: string): HTMLElement {
      const option = within(listbox)
        .getAllByRole("option")
        .find((o) => o.textContent?.startsWith(label));
      if (!option) throw new Error(`option not found: ${label}`);
      option.focus();
      expect(option).toHaveFocus();
      return option;
    }

    it("moves focus to the trigger after an option is chosen, which then names the new scope", () => {
      render(<StatefulDropdown initial="all-except-self" />);
      const option = focusOption(openListbox(), "自己的書");

      fireEvent.click(option);

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveFocus();
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：自己的書，2 本",
      );
    });

    it("moves focus to the trigger when the menu is closed with Escape", () => {
      renderDropdown();
      focusOption(openListbox(), "所有人的書");

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveFocus();
    });

    it("leaves focus on the outside element when the menu is closed by an outside mousedown", () => {
      render(
        <div>
          <button type="button">outside</button>
          {dropdownElement()}
        </div>,
      );
      openListbox();
      const outside = screen.getByRole("button", { name: "outside" });
      outside.focus();

      fireEvent.mouseDown(outside);

      // Positive companion: the mousedown did dismiss the menu.
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(outside).toHaveFocus();
      expect(memberFilterTrigger()).not.toHaveFocus();
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
        "篩選成員：所有人的書，5 本",
      );
    });

    // Trigger and menu must show the same number for the same option.
    it.each<{ value: MemberFilterValue; expected: string }>([
      { value: "all", expected: "5" },
      { value: "all-except-self", expected: "3" },
      { value: SELF_ID, expected: "2" },
      { value: ALICE_ID, expected: "3" },
      { value: FAVORITE_FILTER_VALUE, expected: "5" },
      { value: HIDDEN_FILTER_VALUE, expected: "4" },
    ])(
      "shows $expected on the trigger for $value, equal to the selected option's menu count",
      ({ value, expected }) => {
        renderDropdown({ value });
        expect(triggerCount()).toBe(expected);

        const listbox = openListbox();
        const selected = within(listbox)
          .getAllByRole("option")
          .find((o) => o.getAttribute("aria-selected") === "true");
        if (!selected) throw new Error("no selected option");
        expect(optionCount(selected)).toBe(expected);
      },
    );

    it("updates the trigger count when the user switches to 自己的書", () => {
      render(<StatefulDropdown initial="all-except-self" />);
      expect(triggerCount()).toBe("3");

      const listbox = openListbox();
      const self = within(listbox)
        .getAllByRole("option")
        .find((o) => o.textContent?.startsWith("自己的書"));
      if (!self) throw new Error("self option not found");
      fireEvent.click(self);

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(memberFilterTrigger()).toHaveTextContent("自己的書");
      expect(triggerCount()).toBe("2");
    });
  });

  // The aria-label replaces the button text for assistive tech, so it must
  // announce the same label and count the trigger shows. Literal strings pin the
  // production copy (memberFilterAccessibleName in shared/src/familyShelf/).
  describe("trigger accessible name", () => {
    it("announces the default selection's label and count, not the bare prefix", () => {
      renderDropdown();
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：所有人的書，5 本",
      );
      // Sibling variant: the old static name must be gone.
      expect(memberFilterTrigger()).not.toHaveAccessibleName("篩選成員");
    });

    it.each<{ value: MemberFilterValue; expected: string }>([
      { value: "all-except-self", expected: "篩選成員：其他家人的書，3 本" },
      { value: SELF_ID, expected: "篩選成員：自己的書，2 本" },
      { value: ALICE_ID, expected: "篩選成員：Alice，3 本" },
      { value: FAVORITE_FILTER_VALUE, expected: "篩選成員：我的最愛，5 本" },
      { value: HIDDEN_FILTER_VALUE, expected: "篩選成員：隱藏的書，4 本" },
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

      const pick = (label: string) => {
        const option = within(openListbox())
          .getAllByRole("option")
          .find((o) => o.textContent?.startsWith(label));
        if (!option) throw new Error(`option not found: ${label}`);
        fireEvent.click(option);
      };

      pick("自己的書");
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：自己的書，2 本",
      );

      pick("我的最愛");
      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：我的最愛，5 本",
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
        dropdownElement({
          value: "all-except-self",
          hiddenCount: 1,
          hiddenRefs: new Set([familyPrefRef(ALICE_ID, "b2")]),
        }),
      );

      expect(memberFilterTrigger()).toHaveAccessibleName(
        "篩選成員：其他家人的書，2 本",
      );
      expect(triggerCount()).toBe("2");
    });
  });

  describe("hidden books", () => {
    // Hide Alice's b1 and the viewer's b0.
    const HIDDEN = new Set([
      familyPrefRef(ALICE_ID, "b1"),
      familyPrefRef(SELF_ID, "b0"),
    ]);

    it.each<{ label: string; expected: string }>([
      { label: "所有人的書", expected: "3" },
      { label: "其他家人的書", expected: "2" },
      { label: "自己的書", expected: "1" },
      { label: "Alice", expected: "2" },
      // Favorite / hidden come from their props, untouched by hiddenRefs.
      { label: "我的最愛", expected: "5" },
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
        dropdownElement({
          value: "all-except-self",
          hiddenCount: 1,
          hiddenRefs: new Set([familyPrefRef(ALICE_ID, "b2")]),
        }),
      );

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(triggerCount()).toBe("2");
      expect(menuOptionCount("其他家人的書")).toBe("2");
      expect(menuOptionCount("Alice")).toBe("2");
      expect(menuOptionCount("隱藏的書")).toBe("1");
    });

    it("keeps a member whose every book is hidden in the list, with a 0 count", () => {
      renderDropdown({
        hiddenRefs: new Set(
          ["b0", "b1", "b2"].map((id) => familyPrefRef(ALICE_ID, id)),
        ),
        hiddenCount: 3,
      });
      expect(menuOptionCount("Alice")).toBe("0");
    });
  });
});
