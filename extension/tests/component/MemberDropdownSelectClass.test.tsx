import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Contract for the native `<select>` MemberDropdown renders.
 *
 * The retired `formSelectStyle` helper's inline box props (height, padding,
 * border, chevron) moved into the shadow-scoped `.moo-form-select` classes in
 * styles.css. jsdom does not apply stylesheet rules, so the observable contract
 * is now the class list, not computed inline styles:
 *
 * - `.moo-form-select`         — base select chrome (40px height, 12px padding)
 * - `.moo-form-select--full`   — full-width variant (was the call-site spread `width: "100%"`)
 * - `.moo-form-select--mobile` — compact 32px height, present only on mobile
 *
 * The mobile branch is exercised by mocking `useIsMobile` to return true; the
 * desktop branch is the mock's default `false`.
 */

// Default to false (desktop) so a test that forgets `mockReturnValue` cannot
// pass spuriously by treating an `undefined` (falsy) return as desktop.
const isMobileMock = vi.fn<() => boolean>().mockReturnValue(false);
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

// Imported AFTER the mock so the component picks up the mocked hook.
import { MemberDropdown } from "@/dialog/MemberDropdown";

describe("MemberDropdown select class contract", () => {
  it("renders the base full-width select classes on desktop", () => {
    isMobileMock.mockReturnValue(false);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).toHaveClass("moo-form-select");
    expect(select).toHaveClass("moo-form-select--full");
  });

  it("omits the --mobile modifier on desktop (40px height variant)", () => {
    isMobileMock.mockReturnValue(false);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).not.toHaveClass("moo-form-select--mobile");
  });

  it("adds the --mobile modifier on mobile (32px compact height) while staying full-width", () => {
    isMobileMock.mockReturnValue(true);
    render(<MemberDropdown members={[]} userId="u1" value="all" onChange={vi.fn()} />);

    const select = screen.getByLabelText("篩選成員");
    expect(select).toHaveClass("moo-form-select");
    expect(select).toHaveClass("moo-form-select--full");
    expect(select).toHaveClass("moo-form-select--mobile");
  });
});
