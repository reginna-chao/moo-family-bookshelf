import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PublicShareDialog } from "@/dialog/PublicShareDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ApiClient } from "@/api/client";
import type { PublicShelf } from "@/api/types";

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
 * The form controls follow the app-wide fixed-height standard, applied via the
 * shadow-scoped `.moo-public-share__*` classes in styles.css:
 *
 * - `.moo-public-share__input`  — shared input chrome (40px desktop height)
 * - `.moo-public-share__input--mobile`  — 32px mobile height
 * - `.moo-public-share__select` — desktop select: inherits the 40px input chrome,
 *                                  adds the chevron + `padding-right: 2.25rem`
 * - `.moo-public-share__select--mobile` — 32px mobile height for the select
 *
 * jsdom does not apply stylesheet rules, so the observable contract is the class
 * list, not computed heights. The select-vs-mobile distinction and the
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

  it("adds the --mobile modifier (32px height) to the expires select on mobile", async () => {
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
    "gives the sibling title input the base input chrome without the select modifiers on $mode",
    async ({ isMobile }) => {
      vi.mocked(useIsMobile).mockReturnValue(isMobile);
      renderDialog(makeApiClient());

      const input = await screen.findByRole("textbox");
      expect(input).toHaveClass("moo-public-share__input");
      // The title input shares the input chrome (and picks up `--mobile` on
      // mobile), but must never gain the select-specific chevron/height modifiers.
      expect(input).not.toHaveClass("moo-public-share__select");
      expect(input).not.toHaveClass("moo-public-share__select--mobile");
    },
  );
});

/**
 * Behavior-preservation for the FE-5 refactor: the title write moved from a
 * hand-rolled `titleTimerRef` setTimeout to `useDebouncedCallback`, and the
 * "已複製" flag moved from a `useState` + setTimeout to `useTimedFlag`. The
 * mounted-component behavior (debounce the write; show the flag for its window)
 * must be unchanged. These tests exercise the "active shelf" view, which the
 * class-contract suite above does not reach.
 */
describe("PublicShareDialog · debounce + copy-flag behavior (FE-5)", () => {
  const SHELF: PublicShelf = {
    shelfId: "shelf-1",
    shareToken: "tok-abc",
    title: "小明 的公開書櫃",
    expiresDays: 30,
    createdAt: 0,
    expiresAt: null,
    selectionMode: "all-shared",
  };

  function makeActiveApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
    return {
      listPublicShelves: vi.fn().mockResolvedValue({ shelves: [SHELF] }),
      updatePublicShelf: vi.fn().mockResolvedValue({ shelf: SHELF }),
      getPublicShelfUrl: vi.fn(
        (token: string) => `https://pwa.example/public/${token}`,
      ),
      ...overrides,
    } as unknown as ApiClient;
  }

  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces the title write so only the last keystroke reaches updatePublicShelf", async () => {
    const apiClient = makeActiveApiClient();
    renderDialog(apiClient);

    // Wait for the active shelf view (title input pre-filled from the shelf).
    const input = await screen.findByLabelText("標題");
    expect(input).toHaveValue("小明 的公開書櫃");

    vi.useFakeTimers();

    // First keystroke arms the 1s timer...
    fireEvent.change(input, { target: { value: "新" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();

    // ...a second keystroke within the window restarts it (no write yet).
    fireEvent.change(input, { target: { value: "新標題" } });
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();

    // Only after the full debounce does the single, latest write fire.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(apiClient.updatePublicShelf).toHaveBeenCalledTimes(1);
    expect(apiClient.updatePublicShelf).toHaveBeenCalledWith(
      "user-1",
      "shelf-1",
      { title: "新標題" },
    );
  });

  it("shows the 已複製 flag on copy and clears it after the timeout", async () => {
    const apiClient = makeActiveApiClient();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderDialog(apiClient);
    await screen.findByLabelText("標題");

    const copyBtn = screen.getByTitle("複製連結");
    expect(screen.queryByText("已複製")).not.toBeInTheDocument();

    // Arm fake timers before the click so useTimedFlag's reset timer is fake.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeText).toHaveBeenCalledWith("https://pwa.example/public/tok-abc");
    expect(screen.getByText("已複製")).toBeInTheDocument();

    // The flag auto-clears once its 2s window elapses.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("已複製")).not.toBeInTheDocument();
  });
});
