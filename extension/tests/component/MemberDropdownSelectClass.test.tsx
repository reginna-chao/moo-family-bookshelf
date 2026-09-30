import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * Responsive class contract for the custom MemberDropdown (rewritten from a
 * native `<select>` into a button trigger + listbox popover).
 *
 * The 40px (desktop) / 32px compact (mobile) sizing lives in the shadow-scoped
 * `.moo-member-filter__trigger` / `.moo-member-filter__menu` classes plus their
 * `--mobile` modifiers in styles.css. jsdom does not apply stylesheet rules, so
 * the observable contract is the modifier-class presence/absence, exercised by
 * mocking `useIsMobile`.
 *
 * The main behavior suite (MemberDropdown.test.tsx) runs against the real
 * `useIsMobile` (desktop default), so this file owns the mobile branch.
 */

// Default to false (desktop) so a test that forgets `mockReturnValue` cannot
// pass spuriously by treating an `undefined` (falsy) return as desktop.
const isMobileMock = vi.fn<() => boolean>().mockReturnValue(false);
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

// Imported AFTER the mock so the component picks up the mocked hook.
import { MemberDropdown } from "@/dialog/MemberDropdown";
import { memberFilterTrigger } from "./helpers/memberFilter";

const baseProps = {
  members: [],
  userId: "u1",
  value: "all" as const,
  onChange: vi.fn(),
  favoriteCount: 0,
  hiddenCount: 0,
  hiddenRefs: new Set<string>(),
};

describe("MemberDropdown responsive class contract", () => {
  it("renders the desktop trigger without the --mobile modifier", () => {
    isMobileMock.mockReturnValue(false);
    render(<MemberDropdown {...baseProps} />);

    const trigger = memberFilterTrigger();
    expect(trigger).toHaveClass("moo-member-filter__trigger");
    expect(trigger).not.toHaveClass("moo-member-filter__trigger--mobile");
  });

  it("keeps the desktop menu without the --mobile modifier when opened", () => {
    isMobileMock.mockReturnValue(false);
    render(<MemberDropdown {...baseProps} />);

    fireEvent.click(memberFilterTrigger());
    const menu = screen.getByRole("listbox", { name: "成員選單" });
    expect(menu).toHaveClass("moo-member-filter__menu");
    expect(menu).not.toHaveClass("moo-member-filter__menu--mobile");
  });

  it("adds the --mobile modifier on the trigger on mobile", () => {
    isMobileMock.mockReturnValue(true);
    render(<MemberDropdown {...baseProps} />);

    const trigger = memberFilterTrigger();
    expect(trigger).toHaveClass("moo-member-filter__trigger");
    expect(trigger).toHaveClass("moo-member-filter__trigger--mobile");
  });

  it("adds the --mobile modifier on the menu on mobile", () => {
    isMobileMock.mockReturnValue(true);
    render(<MemberDropdown {...baseProps} />);

    fireEvent.click(memberFilterTrigger());
    const menu = screen.getByRole("listbox", { name: "成員選單" });
    expect(menu).toHaveClass("moo-member-filter__menu");
    expect(menu).toHaveClass("moo-member-filter__menu--mobile");
  });
});
