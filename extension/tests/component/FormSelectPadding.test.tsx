import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

/**
 * Verifies the responsive inline padding produced by `formSelectStyle` actually
 * reaches the rendered native `<select>` of a consuming component.
 *
 * BookSortDropdown no longer consumes `formSelectStyle` (it was rewritten into a
 * custom listbox dropdown with an icon trigger, no native <select>), so coverage
 * here goes through `MemberDropdown`, which still renders
 * `<select aria-label="篩選成員">` styled with `{ ...formSelectStyle(isMobile),
 * width: "100%" }`. The mobile branch is exercised by mocking `useIsMobile` to
 * return true; the desktop branch is the mock's default `false`.
 */

// Default to false (desktop) so a test that forgets `mockReturnValue` cannot
// pass spuriously by treating an `undefined` (falsy) return as desktop.
const isMobileMock = vi.fn<() => boolean>().mockReturnValue(false);
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

// Imported AFTER the mock so the component picks up the mocked hook.
import { MemberDropdown } from "@/dialog/MemberDropdown";

describe("formSelectStyle inline padding via MemberDropdown", () => {
  // The shorthand `padding` plus `paddingRight: 2.25rem` collapse into the
  // longhand `padding: <v> 2.25rem <v> 12px`, so assert the directional values
  // that carry the responsive behaviour rather than the shorthand string.
  it("renders 8px vertical / 12px left / 2.25rem right padding on desktop", () => {
    isMobileMock.mockReturnValue(false);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).toHaveStyle({
      paddingTop: "8px",
      paddingBottom: "8px",
      paddingLeft: "12px",
      paddingRight: "2.25rem",
    });
  });

  it("renders 5px vertical / 12px left padding on mobile", () => {
    isMobileMock.mockReturnValue(true);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).toHaveStyle({
      paddingTop: "5px",
      paddingBottom: "5px",
      paddingLeft: "12px",
      paddingRight: "2.25rem",
    });
  });

  // Guards the MemberDropdown call-site spread `{ ...formSelectStyle(isMobile),
  // width: "100%" }`: width and the responsive padding must reach the rendered
  // <select> together, so dropping the `width: "100%"` (or the spread) regresses.
  it("renders both width 100% and mobile padding together", () => {
    isMobileMock.mockReturnValue(true);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).toHaveStyle({
      width: "100%",
      paddingTop: "5px",
      paddingBottom: "5px",
      paddingLeft: "12px",
    });
  });
});
