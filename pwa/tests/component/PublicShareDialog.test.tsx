import { describe, it, expect, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { PublicShareDialog } from "@/components/PublicShareDialog";
import { ApiError, type ApiClient, type PublicShelf } from "@/api/client";
import {
  publicShelfErrorMessage,
  publicShelfSaveErrorMessage,
  UNSAVED_NOTICE,
  BLANK_TITLE_MESSAGE,
} from "@/utils/publicShareMessages";

const SHELF: PublicShelf = {
  shelfId: "shelf-1",
  shareToken: "tok-abc",
  title: "小明 的公開書櫃",
  expiresDays: 30,
  createdAt: 0,
  expiresAt: null,
  selectionMode: "all-shared",
};

const PUBLIC_URL = `${window.location.origin}/public/${SHELF.shareToken}`;

/** Client whose initial load lands on the "active shelf" view. */
function makeActiveApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPublicShelves: vi.fn().mockResolvedValue({ shelves: [SHELF] }),
    updatePublicShelf: vi.fn().mockResolvedValue({ shelf: SHELF }),
    resetPublicShelfToken: vi.fn().mockResolvedValue({ shelf: SHELF }),
    deletePublicShelf: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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
 * `@/utils/publicShareMessages` (whose literals are pinned in
 * `tests/unit/publicShareMessages.test.ts`), except the one production-literal
 * assertion marked below.
 */
describe("PublicShareDialog · refused writes never advance the UI", () => {
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
      renderDialog(
        makeActiveApiClient({
          deletePublicShelf: vi
            .fn()
            .mockRejectedValue(
              new ApiError("RATE_LIMITED", "too many requests", 45),
            ),
        }),
      );
      await screen.findByLabelText("標題");

      await confirmAction("關閉公開分享");

      // PRODUCTION-LITERAL PIN (see the copy-pin unit test for the full table).
      expect(screen.getByRole("alert")).toHaveTextContent(
        "嘗試次數過多，請於 45 秒後再試。",
      );
      expect(
        screen.getByRole("button", { name: "關閉公開分享" }),
      ).toBeInTheDocument();
      expect(screen.getByDisplayValue(PUBLIC_URL)).toBeInTheDocument();
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
        renderDialog(
          makeActiveApiClient({
            deletePublicShelf: vi.fn().mockRejectedValue(error),
          }),
        );
        await screen.findByLabelText("標題");

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
      renderDialog(apiClient);
      await screen.findByLabelText("標題");

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
      renderDialog(
        makeActiveApiClient({
          updatePublicShelf: vi.fn().mockRejectedValue(error),
        }),
      );
      const input = await screen.findByLabelText("標題");

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
      renderDialog(apiClient);
      const input = await screen.findByLabelText("標題");

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
      renderDialog(makeActiveApiClient({ updatePublicShelf }));
      const input = await screen.findByLabelText("標題");

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
      renderDialog(makeActiveApiClient({ updatePublicShelf }));
      await screen.findByLabelText("標題");

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
      renderDialog(apiClient);
      const input = await screen.findByLabelText("標題");

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
      renderDialog(
        makeActiveApiClient({
          resetPublicShelfToken: vi.fn().mockRejectedValue(error),
        }),
      );
      await screen.findByLabelText("標題");

      await confirmAction("重設網址");

      expect(screen.getByRole("alert")).toHaveTextContent(
        publicShelfErrorMessage(error, "重設失敗"),
      );
      expect(screen.getByDisplayValue(PUBLIC_URL)).toBeInTheDocument();
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
      expect(screen.getByDisplayValue(PUBLIC_URL)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("swaps in the new link after a confirmed token reset", async () => {
      renderDialog(
        makeActiveApiClient({
          resetPublicShelfToken: vi
            .fn()
            .mockResolvedValue({ shelf: { ...SHELF, shareToken: "tok-new" } }),
        }),
      );
      await screen.findByLabelText("標題");

      await confirmAction("重設網址");

      expect(
        screen.getByDisplayValue(`${window.location.origin}/public/tok-new`),
      ).toBeInTheDocument();
      expect(screen.queryByDisplayValue(PUBLIC_URL)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});
