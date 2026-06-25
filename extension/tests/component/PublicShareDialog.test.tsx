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

describe("PublicShareDialog · ExpiresSelect padding", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  it("applies desktop vertical padding (6px) to the expires select on desktop", async () => {
    renderDialog(makeApiClient());

    const select = await screen.findByRole("combobox");
    expect(select.style.paddingTop).toBe("6px");
    expect(select.style.paddingBottom).toBe("6px");
    expect(select.style.paddingRight).toBe("2.25rem");
    expect(select.style.fontSize).toBe("13px");
  });

  it("applies compact vertical padding (4px) to the expires select on mobile", async () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderDialog(makeApiClient());

    const select = await screen.findByRole("combobox");
    expect(select.style.paddingTop).toBe("4px");
    expect(select.style.paddingBottom).toBe("4px");
    expect(select.style.paddingRight).toBe("2.25rem");
    expect(select.style.fontSize).toBe("13px");
  });

  it.each([
    { mode: "desktop", isMobile: false },
    { mode: "mobile", isMobile: true },
  ])("leaves the sibling title input padding unchanged on $mode", async ({ isMobile }) => {
    vi.mocked(useIsMobile).mockReturnValue(isMobile);
    renderDialog(makeApiClient());

    const input = await screen.findByRole("textbox");
    expect(input.style.paddingTop).toBe("6px");
    expect(input.style.paddingBottom).toBe("6px");
  });
});
