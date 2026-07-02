import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PublicShareDialog } from "@/dialog/PublicShareDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ApiClient } from "@/api/client";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

function makeApiClient() {
  return {
    listPublicShelves: vi.fn().mockResolvedValue({ shelves: [] }),
  } as unknown as ApiClient;
}

function renderDialog(apiClient: ApiClient) {
  return render(
    <PublicShareDialog
      userId="user-1"
      apiClient={apiClient}
      defaultDisplayName="小明"
      onClose={vi.fn()}
    />,
  );
}

/**
 * The ExpiresSelect vertical-padding refactor moved from inline styles into the
 * shadow-scoped `.moo-public-share__*` classes in styles.css:
 *
 * - `.moo-public-share__input`  — shared input chrome (6px/10px base padding)
 * - `.moo-public-share__select` — desktop select: inherits the 6px input padding,
 *                                  adds the chevron + `padding-right: 2.25rem`
 * - `.moo-public-share__select--mobile` — compact 4px vertical padding
 *
 * jsdom does not apply stylesheet rules, so the observable contract is the class
 * list, not computed inline styles. The select-vs-mobile distinction and the
 * "sibling title input keeps the base input chrome" intent are asserted via the
 * class contract below.
 */
describe("PublicShareDialog · ExpiresSelect class contract", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("applies the base input + select classes (no --mobile) to the expires select on desktop", async () => {
    renderDialog(makeApiClient());

    const select = await screen.findByRole("combobox");
    expect(select).toHaveClass("moo-public-share__input");
    expect(select).toHaveClass("moo-public-share__select");
    expect(select).not.toHaveClass("moo-public-share__select--mobile");
  });

  it("adds the --mobile modifier (compact padding) to the expires select on mobile", async () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderDialog(makeApiClient());

    const select = await screen.findByRole("combobox");
    expect(select).toHaveClass("moo-public-share__input");
    expect(select).toHaveClass("moo-public-share__select");
    expect(select).toHaveClass("moo-public-share__select--mobile");
  });

  it.each([
    { mode: "desktop", isMobile: false },
    { mode: "mobile", isMobile: true },
  ])(
    "leaves the sibling title input on the base input chrome (no select modifier) on $mode",
    async ({ isMobile }) => {
      vi.mocked(useIsMobile).mockReturnValue(isMobile);
      renderDialog(makeApiClient());

      const input = await screen.findByRole("textbox");
      expect(input).toHaveClass("moo-public-share__input");
      // The title input must not pick up the select's padding modifiers.
      expect(input).not.toHaveClass("moo-public-share__select");
      expect(input).not.toHaveClass("moo-public-share__select--mobile");
    },
  );
});
