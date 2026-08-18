import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PublicShareDialog } from "@/dialog/PublicShareDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ApiClient } from "@/api/client";
import { ApiError, type PublicShelf } from "@/api/types";
import {
  publicShelfErrorMessage,
  publicShelfSaveErrorMessage,
  UNSAVED_NOTICE,
  BLANK_TITLE_MESSAGE,
} from "@/dialog/publicShareMessages";

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

function makeApiClient() {
  return {
    listPublicShelves: vi.fn().mockResolvedValue({ shelves: [] }),
  } as unknown as ApiClient;
}

const SHELF: PublicShelf = {
  shelfId: "shelf-1",
  shareToken: "tok-abc",
  title: "小明 的公開書櫃",
  expiresDays: 30,
  createdAt: 0,
  expiresAt: null,
  selectionMode: "all-shared",
};

/** Client whose initial load lands on the "active shelf" view. */
function makeActiveApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPublicShelves: vi.fn().mockResolvedValue({ shelves: [SHELF] }),
    updatePublicShelf: vi.fn().mockResolvedValue({ shelf: SHELF }),
    resetPublicShelfToken: vi.fn().mockResolvedValue({ shelf: SHELF }),
    deletePublicShelf: vi.fn().mockResolvedValue(undefined),
    getPublicShelfUrl: vi.fn(
      (token: string) => `https://pwa.example/public/${token}`,
    ),
    ...overrides,
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
 * Render, then settle the initial load — and hand back the 標題 input.
 *
 * `findByLabelText` alone is not a readiness signal: DOM presence != effects
 * flushed. It waits with the act environment disabled and ends on a bare
 * `setTimeout(0)`, so React may still owe the passive effect that publishes the
 * active shelfId; a write fired in that window is silently dropped by the
 * hook's shelfId guard. Only `act` guarantees pending effects flush on exit.
 * Call it BEFORE any `vi.useFakeTimers()` — it awaits real microtasks.
 */
async function renderSettledDialog(apiClient: ApiClient): Promise<HTMLElement> {
  await act(async () => {
    renderDialog(apiClient);
  });
  // getBy, not findBy: a load that failed to settle must fail loudly right here.
  // The 標題 label exists in the create view too, so pin the ACTIVE view — a
  // caller passing `{ shelves: [] }` must fail here, not silently drive the
  // create form.
  expect(
    screen.getByRole("button", { name: "關閉公開分享" }),
  ).toBeInTheDocument();
  return screen.getByLabelText("標題");
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
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces the title write so only the last keystroke reaches updatePublicShelf", async () => {
    const apiClient = makeActiveApiClient();

    // Settle into the active shelf view (title input pre-filled from the shelf).
    const input = await renderSettledDialog(apiClient);
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

    await renderSettledDialog(apiClient);

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
      await renderSettledDialog(makeActiveApiClient());

      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("moo-button");
      expect(button).toHaveClass("moo-button--sm");
      expect(button).toHaveClass(modifier);
    },
  );
});

/** Promise the test resolves by hand, to hold a write "in flight". */
function createDeferred<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

/**
 * Fail-open fix: a refused write must never advance the UI past what the server
 * confirmed, and its reason must reach the user in 繁體中文.
 *
 * Copy is asserted through the production builders in
 * `@/dialog/publicShareMessages` (whose literals are pinned in
 * `tests/unit/dialog/publicShareMessages.test.ts`), except the one
 * production-literal assertion marked below.
 */
describe("PublicShareDialog · refused writes never advance the UI", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Press a destructive action and answer its confirm box with 確定. */
  async function confirmAction(name: "重設網址" | "關閉公開分享") {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "確定" }));
    });
  }

  describe("revoking the public link", () => {
    // The security-critical assertion: the snapshot is still being served, so a
    // refused DELETE must not let the UI claim the link is closed.
    it("keeps the active shelf on screen when the server refuses the revocation", async () => {
      const apiClient = makeActiveApiClient({
        deletePublicShelf: vi
          .fn()
          .mockRejectedValue(
            new ApiError("RATE_LIMITED", "too many requests", 45),
          ),
      });
      await renderSettledDialog(apiClient);

      await confirmAction("關閉公開分享");

      // PRODUCTION-LITERAL PIN (see the copy-pin unit test for the full table).
      expect(screen.getByRole("alert")).toHaveTextContent(
        "嘗試次數過多，請於 45 秒後再試",
      );
      expect(
        screen.getByRole("button", { name: "關閉公開分享" }),
      ).toBeInTheDocument();
      expect(
        screen.getByDisplayValue("https://pwa.example/public/tok-abc"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "啟用公開書櫃" }),
      ).not.toBeInTheDocument();
    });

    it.each([
      { code: "FORBIDDEN", detail: "not your shelf" },
      { code: "SHELF_NOT_FOUND", detail: "shelf not found" },
      { code: "KV_WRITE_FAILED", detail: "internal server error" },
    ])(
      "reports a $code refusal in 繁體中文 and keeps the link live",
      async ({ code, detail }) => {
        const error = new ApiError(code, detail);
        await renderSettledDialog(
          makeActiveApiClient({
            deletePublicShelf: vi.fn().mockRejectedValue(error),
          }),
        );

        await confirmAction("關閉公開分享");

        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent(
          publicShelfErrorMessage(error, "關閉失敗"),
        );
        // Raw server English never reaches the user.
        expect(alert).not.toHaveTextContent(detail);
        expect(alert).not.toHaveTextContent(code);
        expect(
          screen.queryByRole("button", { name: "啟用公開書櫃" }),
        ).not.toBeInTheDocument();
      },
    );

    it("returns to the empty state only after the server confirms the revocation", async () => {
      const apiClient = makeActiveApiClient();
      await renderSettledDialog(apiClient);

      await confirmAction("關閉公開分享");

      expect(apiClient.deletePublicShelf).toHaveBeenCalledWith(
        "user-1",
        "shelf-1",
      );
      expect(
        screen.getByRole("button", { name: "啟用公開書櫃" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "關閉公開分享" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("title / expiry writes", () => {
    it("keeps the typed title and offers 重試儲存 when the write is refused", async () => {
      const error = new ApiError("RATE_LIMITED", "too many requests", 90);
      const apiClient = makeActiveApiClient({
        updatePublicShelf: vi.fn().mockRejectedValue(error),
      });
      const input = await renderSettledDialog(apiClient);

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "新標題" } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      // The user's value survives — it is reported as unsaved, not discarded.
      expect(input).toHaveValue("新標題");
      expect(screen.getByRole("alert")).toHaveTextContent(
        publicShelfSaveErrorMessage(error),
      );
      expect(
        screen.getByRole("button", { name: "重試儲存" }),
      ).toBeInTheDocument();
    });

    it("stays quiet while the write is still queued or in flight", async () => {
      const deferred = createDeferred<{ shelf: PublicShelf }>();
      const apiClient = makeActiveApiClient({
        updatePublicShelf: vi.fn().mockReturnValue(deferred.promise),
      });
      const input = await renderSettledDialog(apiClient);

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "新標題" } });

      // Queued: diverged from the server, but nothing has failed yet.
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(UNSAVED_NOTICE)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      // In flight: still no notice.
      expect(apiClient.updatePublicShelf).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () => {
        deferred.resolve({ shelf: { ...SHELF, title: "新標題" } });
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("re-sends only the diverged title on 重試儲存 and clears the notice on success", async () => {
      const updatePublicShelf = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError("RATE_LIMITED", "too many requests", 45),
        )
        .mockResolvedValue({ shelf: { ...SHELF, title: "新標題" } });
      const input = await renderSettledDialog(
        makeActiveApiClient({ updatePublicShelf }),
      );

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "新標題" } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "重試儲存" }));
      });

      // Echoing the unchanged expiresDays would silently extend the shelf's
      // lifetime, so the retry payload carries the title alone.
      expect(updatePublicShelf).toHaveBeenCalledTimes(2);
      expect(updatePublicShelf).toHaveBeenLastCalledWith("user-1", "shelf-1", {
        title: "新標題",
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(input).toHaveValue("新標題");
    });

    it("re-sends only the diverged expiry, leaving the title out of the payload", async () => {
      const updatePublicShelf = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiError("RATE_LIMITED", "too many requests", 45),
        )
        .mockResolvedValue({ shelf: { ...SHELF, expiresDays: 7 } });
      await renderSettledDialog(makeActiveApiClient({ updatePublicShelf }));

      await act(async () => {
        fireEvent.change(screen.getByRole("combobox"), {
          target: { value: "7" },
        });
      });

      expect(updatePublicShelf).toHaveBeenLastCalledWith("user-1", "shelf-1", {
        expiresDays: 7,
      });
      expect(
        screen.getByRole("button", { name: "重試儲存" }),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "重試儲存" }));
      });

      expect(updatePublicShelf).toHaveBeenCalledTimes(2);
      expect(updatePublicShelf).toHaveBeenLastCalledWith("user-1", "shelf-1", {
        expiresDays: 7,
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("rejects a blank title client-side, without spending an API call", async () => {
      const apiClient = makeActiveApiClient();
      const input = await renderSettledDialog(apiClient);

      vi.useFakeTimers();
      fireEvent.change(input, { target: { value: "   " } });
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(BLANK_TITLE_MESSAGE);

      // The retry affordance must not smuggle the blank title out either.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "重試儲存" }));
      });

      expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(BLANK_TITLE_MESSAGE);
    });
  });

  describe("load / create / reset failures", () => {
    it("reports a refused initial load in 繁體中文 instead of the bare 載入失敗 placeholder", async () => {
      const error = new ApiError("USER_NOT_FOUND", "user not found");
      const apiClient = {
        listPublicShelves: vi.fn().mockRejectedValue(error),
      } as unknown as ApiClient;
      renderDialog(apiClient);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        publicShelfErrorMessage(error, "載入失敗"),
      );
      expect(screen.queryByText("載入失敗")).not.toBeInTheDocument();
    });

    it("reports a refused creation in 繁體中文 and keeps the create form open", async () => {
      const error = new ApiError("MAX_SHELVES_REACHED", "limit reached");
      const apiClient = {
        listPublicShelves: vi.fn().mockResolvedValue({ shelves: [] }),
        createPublicShelf: vi.fn().mockRejectedValue(error),
      } as unknown as ApiClient;
      renderDialog(apiClient);
      const createBtn = await screen.findByRole("button", {
        name: "啟用公開書櫃",
      });

      await act(async () => {
        fireEvent.click(createBtn);
      });

      expect(screen.getByRole("alert")).toHaveTextContent(
        publicShelfErrorMessage(error, "建立失敗"),
      );
      expect(
        screen.getByRole("button", { name: "啟用公開書櫃" }),
      ).toBeInTheDocument();
    });

    it("reports a refused token reset in 繁體中文 and keeps the current link", async () => {
      const error = new ApiError("KV_WRITE_FAILED", "internal server error");
      await renderSettledDialog(
        makeActiveApiClient({
          resetPublicShelfToken: vi.fn().mockRejectedValue(error),
        }),
      );

      await confirmAction("重設網址");

      expect(screen.getByRole("alert")).toHaveTextContent(
        publicShelfErrorMessage(error, "重設失敗"),
      );
      expect(
        screen.getByDisplayValue("https://pwa.example/public/tok-abc"),
      ).toBeInTheDocument();
    });
  });

  // The counterpart of the failure paths above: a confirmed write is exactly
  // when the UI is allowed to move on.
  describe("confirmed writes", () => {
    it("shows the public link once the server confirms the creation", async () => {
      const apiClient = makeActiveApiClient({
        listPublicShelves: vi.fn().mockResolvedValue({ shelves: [] }),
        createPublicShelf: vi.fn().mockResolvedValue({ shelf: SHELF }),
      });
      renderDialog(apiClient);
      const createBtn = await screen.findByRole("button", {
        name: "啟用公開書櫃",
      });

      await act(async () => {
        fireEvent.click(createBtn);
      });

      expect(apiClient.createPublicShelf).toHaveBeenCalledWith("user-1", {
        title: "小明 的公開書櫃",
        expiresDays: 30,
      });
      expect(
        screen.getByDisplayValue("https://pwa.example/public/tok-abc"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("swaps in the new link after a confirmed token reset", async () => {
      await renderSettledDialog(
        makeActiveApiClient({
          resetPublicShelfToken: vi
            .fn()
            .mockResolvedValue({ shelf: { ...SHELF, shareToken: "tok-new" } }),
        }),
      );

      await confirmAction("重設網址");

      expect(
        screen.getByDisplayValue("https://pwa.example/public/tok-new"),
      ).toBeInTheDocument();
      expect(
        screen.queryByDisplayValue("https://pwa.example/public/tok-abc"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
