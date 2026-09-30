import { fireEvent, screen } from "@testing-library/react";

/**
 * DOM probes for the member-filter counts in `src/dialog/MemberDropdown.tsx`.
 *
 * The collapsed trigger renders `label · count`; the count sits in its own
 * `.moo-member-filter__count` span and each menu option's count in
 * `.moo-category__option-count`. Both probes return the span's EXACT text so
 * a caller compares with `toBe` (a substring match would accept `12` for `120`).
 */

/**
 * Matches the trigger's accessible name, `篩選成員：{label}，{count} 本`. It
 * varies with the selection, so the lookup anchors on the fixed prefix plus
 * its full-width colon (no other control's name starts that way). The exact
 * copy is pinned with literal strings in `MemberDropdown.test.tsx`.
 */
export const MEMBER_FILTER_TRIGGER_NAME = /^篩選成員：/;

/** The member-filter trigger button (its accessible name is the aria-label). */
export function memberFilterTrigger(): HTMLElement {
  return screen.getByRole("button", { name: MEMBER_FILTER_TRIGGER_NAME });
}

/** Exact text of the count shown on the (collapsed or open) trigger. */
export function triggerCount(): string {
  const count = memberFilterTrigger().querySelector(
    ".moo-member-filter__count",
  );
  if (!count) throw new Error("trigger count span not found");
  return count.textContent ?? "";
}

/** Exact text of the count inside one menu option element. */
export function optionCount(option: HTMLElement): string {
  const count = option.querySelector(".moo-category__option-count");
  if (!count) throw new Error("option count span not found");
  return count.textContent ?? "";
}

/**
 * Read the menu count of the option whose text starts with `label`. Opens the
 * menu when it is closed and closes it again afterwards, so the caller's
 * collapsed / open state is preserved.
 */
export function menuOptionCount(label: string): string {
  const wasOpen = screen.queryByRole("listbox", { name: "成員選單" }) !== null;
  if (!wasOpen) fireEvent.click(memberFilterTrigger());
  const option = screen
    .getAllByRole("option")
    .find((el) => el.textContent?.startsWith(label));
  if (!option) throw new Error(`member option not found: ${label}`);
  const count = optionCount(option);
  if (!wasOpen) fireEvent.click(memberFilterTrigger());
  return count;
}
