import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import React from "react";
import { MemberDropdown } from "@/components/MemberDropdown";
import {
  FAVORITE_FILTER_VALUE,
  HIDDEN_FILTER_VALUE,
  type MemberFilterValue,
} from "@/hooks/useFamilyShelfBooks";
import type { MemberBooks } from "@/hooks/useFamilyData";
import { BoolFlag, type BookEntry } from "@/api/client";

afterEach(cleanup);

const SELF_ID = "user-self";
const ALICE_ID = "user-alice";
const BOB_ID = "user-bob";

/** Minimal book stubs — MemberDropdown only reads `books.length`. */
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
}

function renderDropdown({
  value = "all",
  onChange = vi.fn(),
  favoriteCount = 5,
  hiddenCount = 4,
}: RenderArgs = {}) {
  return render(
    <MemberDropdown
      members={members}
      userId={SELF_ID}
      value={value}
      onChange={onChange}
      favoriteCount={favoriteCount}
      hiddenCount={hiddenCount}
    />,
  );
}

function openListbox(): HTMLElement {
  fireEvent.click(screen.getByLabelText("篩選成員"));
  return screen.getByRole("listbox", { name: "成員選單" });
}

describe("MemberDropdown", () => {
  it("shows the label of the currently selected option on the trigger", () => {
    renderDropdown({ value: SELF_ID });
    const trigger = screen.getByLabelText("篩選成員");
    expect(trigger).toHaveTextContent("自己的書");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("falls back to the first option's label when value matches no option", () => {
    renderDropdown({ value: "unknown-user" });
    expect(screen.getByLabelText("篩選成員")).toHaveTextContent("所有人的書");
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
      expect(opt).toHaveTextContent(expected[i].count);
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
        />
      </div>,
    );

    fireEvent.click(screen.getByLabelText("篩選成員"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
