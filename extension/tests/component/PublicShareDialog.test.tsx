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

function renderDialog(
  apiClient: ApiClient,
  options?: Parameters<typeof render>[1],
) {
  return render(
    <PublicShareDialog
      userId="user-1"
      apiClient={apiClient}
      defaultDisplayName="小明"
      onClose={vi.fn()}
    />,
    options,
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

  // The bespoke input chrome was folded into the shared `.moo-form-input`
  // component class; the `--select` modifier only adjusts CSS variables.
  it("opts the title input and the expires select into the shared .moo-form-input base", async () => {
    renderDialog(makeApiClient());

    const input = await screen.findByRole("textbox");
    expect(input).toHaveClass("moo-form-input");
    expect(input).not.toHaveClass("moo-form-input--select");

    const select = screen.getByRole("combobox");
    expect(select).toHaveClass("moo-form-input");
    expect(select).toHaveClass("moo-form-input--select");
  });

  it("opts the close button into the shared ghost-icon button base", async () => {
    const { container } = renderDialog(makeApiClient());

    const closeBtn = container.querySelector(".moo-public-share__icon-btn");
    expect(closeBtn).toHaveClass("moo-button");
    expect(closeBtn).toHaveClass("moo-button--ghost-icon");

    await screen.findByRole("combobox");
  });

  it("opts the create button into the shared small primary button base", async () => {
    renderDialog(makeApiClient());

    const createBtn = await screen.findByRole("button", {
      name: "啟用公開書櫃",
    });
    expect(createBtn).toHaveClass("moo-button");
    expect(createBtn).toHaveClass("moo-button--sm");
    // The default (primary) variant carries no colour modifier.
    expect(createBtn).not.toHaveClass("moo-button--ghost");
    expect(createBtn).not.toHaveClass("moo-button--outline-danger");
  });
});

/**
 * The dialog is a modal: it renders after the trigger in DOM order, so without
 * explicit focus management Tab would walk the shelf controls behind it. On mount
 * it captures the opener from the (shadow-aware) root's `activeElement`, moves
 * focus into its own container, and hands focus back to the opener on unmount.
 */
describe("PublicShareDialog · modal focus management", () => {
  let opener: HTMLButtonElement;

  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    opener = document.createElement("button");
    opener.textContent = "公開分享";
    document.body.appendChild(opener);
    opener.focus();
  });

  afterEach(() => {
    opener.remove();
  });

  it("exposes modal semantics on the focusable dialog container", async () => {
    renderDialog(makeApiClient());

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "公開書櫃分享");
    expect(dialog).toHaveAttribute("tabindex", "-1");

    // Settle the initial listPublicShelves promise before unmounting.
    await screen.findByRole("combobox");
  });

  it("moves focus into the dialog container on open", async () => {
    renderDialog(makeApiClient());

    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    expect(document.activeElement).not.toBe(opener);

    await screen.findByRole("combobox");
  });

  it("restores focus to the opener when the dialog unmounts", async () => {
    const { unmount } = renderDialog(makeApiClient());
    await screen.findByRole("combobox");
    expect(document.activeElement).not.toBe(opener);

    unmount();

    expect(document.activeElement).toBe(opener);
  });

  describe("mounted inside an open shadow root", () => {
    let host: HTMLDivElement;
    let shadowRoot: ShadowRoot;
    let reactContainer: HTMLDivElement;
    let shadowOpener: HTMLButtonElement;

    beforeEach(() => {
      host = document.createElement("div");
      document.body.appendChild(host);
      shadowRoot = host.attachShadow({ mode: "open" });
      shadowOpener = document.createElement("button");
      shadowOpener.textContent = "公開分享";
      shadowRoot.appendChild(shadowOpener);
      reactContainer = document.createElement("div");
      shadowRoot.appendChild(reactContainer);
      shadowOpener.focus();
    });

    afterEach(() => {
      host.remove();
    });

    // `document.activeElement` is retargeted to the shadow host here, so reading
    // it instead of `getRootNode().activeElement` would capture the host as the
    // opener and focus would never return to the 公開分享 button.
    it("captures the shadow-DOM opener and restores focus to it on unmount", async () => {
      expect(shadowRoot.activeElement).toBe(shadowOpener);

      const { unmount } = renderDialog(makeApiClient(), {
        container: reactContainer,
      });

      const dialog = shadowRoot.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(shadowRoot.activeElement).toBe(dialog);

      // Let the initial listPublicShelves promise resolve inside act().
      await act(async () => {});

      unmount();

      expect(shadowRoot.activeElement).toBe(shadowOpener);
    });
  });
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

    expect(writeText).toHaveBeenCalledWith(
      "https://pwa.example/public/tok-abc",
    );
    expect(screen.getByText("已複製")).toBeInTheDocument();

    // The flag auto-clears once its 2s window elapses.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("已複製")).not.toBeInTheDocument();
  });

  // Active-shelf actions are the only place in this dialog that uses the
  // secondary/destructive button variants; pin their shared bases so the
  // refactor cannot silently drop them.
  it.each([
    { name: "重設網址", modifier: "moo-button--ghost" },
    { name: "關閉公開分享", modifier: "moo-button--outline-danger" },
  ])(
    "opts the $name action into the shared $modifier button base",
    async ({ name, modifier }) => {
      renderDialog(makeActiveApiClient());
      await screen.findByLabelText("標題");

      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("moo-button");
      expect(button).toHaveClass("moo-button--sm");
      expect(button).toHaveClass(modifier);
    },
  );
});
