import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import type { PublicShelfUpdate } from "moo-family-bookshelf-shared/publicShelf/diff";
import { PublicShareDialog } from "@/dialog/PublicShareDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ApiClient } from "@/api/client";
import { ApiError, type PublicShelf } from "@/api/types";
import {
  publicShelfSaveErrorMessage,
  UNSAVED_NOTICE,
} from "@/dialog/publicShareMessages";

/**
 * PublicShareDialog write-through sequencing: the debounced title / expiry writes, their failures,
 * skipped no-op writes, and adoption of server-sanitized titles.
 *
 * Readiness: `findByLabelText` alone is not a readiness signal — DOM presence != effects flushed. It
 * waits with the act environment disabled and ends on a bare `setTimeout(0)`, so React may still owe
 * the passive effect that publishes the active shelfId, and a write fired in that window is silently
 * dropped by the hook's shelfId guard; only `act` guarantees pending effects flush on exit.
 * renderSettledDialog awaits real microtasks, so call it BEFORE any `vi.useFakeTimers()`.
 * confirmAction drains BOTH clicks inside `act`: the confirm click's handler awaits the API call and
 * then owes the `[shelf]` passive effect that clears the active shelfId; that drain crosses a
 * macrotask hop the fake clock never patches, so leaving the first click on RTL's synchronous act
 * alone made the second act carry work it might finish one flush short of — and a queued write then
 * slipped past the shelfId guard. Every gate in confirmAction must stay a synchronous `getBy`: most
 * callers run under vi fake timers, which RTL cannot detect, so a `waitFor` / `findBy*` would poll a
 * frozen clock and hang to the full test timeout.
 *
 * Concurrent writes: the dialog fires these write-through requests without blocking the UI, so the
 * queue, the wire and the server's answers can interleave in any order. Each case pins one
 * interleaving that previously alarmed the user about a change still on its way, spent a needless
 * request, or let a stale answer overwrite a newer one.
 *
 * Failures of writes that lost their turn: the catch path suppresses its message for exactly one
 * reason — the user confirmed a revocation while the write was on the wire, so there is no field left
 * to reconcile and a red 找不到這個公開書櫃 over a successful 關閉公開分享 would be pure noise. Being
 * outranked by a NEWER write is NOT such a reason: that write's own field can stay diverged, so its
 * failure must still surface.
 */

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: vi.fn(() => false),
}));

/** Zero-width space: survives `trim()`, so only the server can strip it. */
const ZWSP = "\u200b";

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

/** Stateful stand-in for the server's shelf: an update applies the body and echoes the whole record,
 *  as the API does — a frozen mock would fake divergence into (or out of) existence between writes. */
function createShelfServer(initial: PublicShelf = SHELF) {
  let stored = initial;
  return {
    updatePublicShelf: vi.fn(
      (_userId: string, _shelfId: string, body: PublicShelfUpdate) => {
        stored = { ...stored, ...body };
        return Promise.resolve({ shelf: stored });
      },
    ),
    resetPublicShelfToken: vi.fn(() => {
      stored = { ...stored, shareToken: "tok-new" };
      return Promise.resolve({ shelf: stored });
    }),
  };
}

/** Promise the test settles by hand, to hold a write "in flight". */
function createDeferred<T>() {
  let settleResolve: (value: T) => void = () => {};
  let settleReject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  return {
    promise,
    resolve: (value: T) => settleResolve(value),
    reject: (reason: unknown) => settleReject(reason),
  };
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

/** Render, settle the initial load inside `act`, and return the 標題 input. Call BEFORE any
 *  `vi.useFakeTimers()`. See the file header, "Readiness". */
async function renderSettledDialog(apiClient: ApiClient): Promise<HTMLElement> {
  await act(async () => {
    renderDialog(apiClient);
  });
  // getBy, not findBy: an unsettled load must fail loudly here. 標題 also exists in the create view, so
  // pin the ACTIVE view — `{ shelves: [] }` must fail here, not silently drive the create form.
  expect(
    screen.getByRole("button", { name: "關閉公開分享" }),
  ).toBeInTheDocument();
  return screen.getByLabelText("標題");
}

/** Neither the unsaved notice nor its retry affordance is on screen. */
function expectNoUnsavedNotice() {
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "重試儲存" }),
  ).not.toBeInTheDocument();
  expect(screen.queryAllByText(new RegExp(UNSAVED_NOTICE))).toHaveLength(0);
}

/** Press a destructive action and answer its confirm box with 確定, both clicks drained in `act`; gates
 *  stay synchronous `getBy` (fake timers). See the file header, "Readiness". */
async function confirmAction(name: "重設網址" | "關閉公開分享") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  // getBy, not findBy: the confirm box must be committed, not merely coming.
  expect(screen.getByRole("button", { name: "確定" })).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "確定" }));
  });
}

/** Write sequencing for the debounced title / expiry writes; each case pins one past interleaving bug.
 *  See the file header, "Concurrent writes". */
describe("PublicShareDialog · concurrent title / expiry writes", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Queue and wire are independent states: an expiry write finishing must not
  // report a title edit that is still waiting out its debounce as unsaved.
  it("stays quiet when an expiry write completes while a title edit is still queued", async () => {
    const server = createShelfServer();
    const input = await renderSettledDialog(makeActiveApiClient(server));

    vi.useFakeTimers();
    // A title edit is now sitting in the debounce queue...
    fireEvent.change(input, { target: { value: "新標題" } });
    // ...and an expiry write starts and finishes before that queue drains.
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "7" },
      });
    });

    expect(server.updatePublicShelf).toHaveBeenCalledTimes(1);
    expect(server.updatePublicShelf).toHaveBeenLastCalledWith(
      "user-1",
      "shelf-1",
      { expiresDays: 7 },
    );
    expectNoUnsavedNotice();

    // The queued title write then runs on its own schedule, still silently.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(server.updatePublicShelf).toHaveBeenCalledTimes(2);
    expect(server.updatePublicShelf).toHaveBeenLastCalledWith(
      "user-1",
      "shelf-1",
      { title: "新標題" },
    );
    expect(input).toHaveValue("新標題");
    expectNoUnsavedNotice();
  });

  // The shelfId is gone once the revocation is confirmed, so firing the queued
  // write would only paint a red SHELF_NOT_FOUND over a successful action.
  it("drops a queued title write when the shelf was revoked during the debounce", async () => {
    const apiClient = makeActiveApiClient();
    const input = await renderSettledDialog(apiClient);

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "新標題" } });
    await confirmAction("關閉公開分享");
    // The revocation is fully committed (the create view shows). Only past this point does the queued
    // write face the null shelfId this test is about.
    expect(
      screen.getByRole("button", { name: "啟用公開書櫃" }),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "啟用公開書櫃" }),
    ).toBeInTheDocument();
    expectNoUnsavedNotice();
  });

  // Counter-case: a token reset keeps the same shelfId, so the queued write is
  // still addressed to a live resource and must go through.
  it("still fires a queued title write after a token reset, which keeps the shelfId", async () => {
    const server = createShelfServer();
    const input = await renderSettledDialog(makeActiveApiClient(server));

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "新標題" } });
    await confirmAction("重設網址");

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(server.updatePublicShelf).toHaveBeenCalledTimes(1);
    expect(server.updatePublicShelf).toHaveBeenCalledWith("user-1", "shelf-1", {
      title: "新標題",
    });
    expect(
      screen.getByDisplayValue("https://pwa.example/public/tok-new"),
    ).toBeInTheDocument();
    expect(input).toHaveValue("新標題");
    expectNoUnsavedNotice();
  });

  // Fire-and-forget writes have no ordering guarantee on the wire; the UI must
  // reflect the newest one that was issued, not the last one that answered.
  it("keeps the later-issued write's result when the earlier response lands last", async () => {
    const earlier = createDeferred<{ shelf: PublicShelf }>();
    const later = createDeferred<{ shelf: PublicShelf }>();
    const updatePublicShelf = vi
      .fn()
      .mockReturnValueOnce(earlier.promise)
      .mockReturnValueOnce(later.promise);
    await renderSettledDialog(makeActiveApiClient({ updatePublicShelf }));

    // Real timers: the issue order is synchronous today (`runUpdate` reaches `updatePublicShelf` with no
    // `await` first); these waits pin it on an observable, so a future await keeps "earlier" well-defined.
    const select = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(select, { target: { value: "7" } });
    });
    await waitFor(() => expect(updatePublicShelf).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.change(select, { target: { value: "60" } });
    });
    await waitFor(() => expect(updatePublicShelf).toHaveBeenCalledTimes(2));

    // The later-issued write answers first...
    await act(async () => {
      later.resolve({
        shelf: { ...SHELF, shareToken: "tok-latest", expiresDays: 60 },
      });
    });
    // ...so the straggler must not roll the UI back to its own result.
    await act(async () => {
      earlier.resolve({
        shelf: { ...SHELF, shareToken: "tok-stale", expiresDays: 7 },
      });
    });

    expect(
      screen.getByDisplayValue("https://pwa.example/public/tok-latest"),
    ).toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("https://pwa.example/public/tok-stale"),
    ).not.toBeInTheDocument();
    expectNoUnsavedNotice();
  });
});

/** A rejected write reports — unless the shelf it addressed no longer exists; being outranked by a newer
 *  write does not suppress it. See the file header, "Failures of writes that lost their turn". */
describe("PublicShareDialog · failures of writes that lost their turn", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays silent when a mid-flight write fails after the shelf was revoked", async () => {
    const inFlight = createDeferred<{ shelf: PublicShelf }>();
    const apiClient = makeActiveApiClient({
      updatePublicShelf: vi.fn().mockReturnValue(inFlight.promise),
    });
    await renderSettledDialog(apiClient);

    // An expiry write is on the wire...
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "7" },
      });
    });
    expect(apiClient.updatePublicShelf).toHaveBeenCalledTimes(1);

    // ...and the user revokes the shelf before it answers.
    await confirmAction("關閉公開分享");
    expect(
      screen.getByRole("button", { name: "啟用公開書櫃" }),
    ).toBeInTheDocument();

    // The straggler then fails against a shelfId that no longer exists.
    await act(async () => {
      inFlight.reject(new ApiError("SHELF_NOT_FOUND", "shelf not found"));
    });

    expectNoUnsavedNotice();
    expect(
      screen.getByRole("button", { name: "啟用公開書櫃" }),
    ).toBeInTheDocument();
  });

  it("still reports a rejected write that was merely superseded by a newer one", async () => {
    const superseded = createDeferred<{ shelf: PublicShelf }>();
    const newer = createDeferred<{ shelf: PublicShelf }>();
    const updatePublicShelf = vi
      .fn()
      .mockReturnValueOnce(superseded.promise)
      .mockReturnValueOnce(newer.promise);
    const input = await renderSettledDialog(
      makeActiveApiClient({ updatePublicShelf }),
    );

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "新標題" } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // An expiry write outranks the title write still waiting for its answer.
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "7" },
      });
    });
    expect(updatePublicShelf).toHaveBeenCalledTimes(2);

    const error = new ApiError("RATE_LIMITED", "too many requests", 45);
    await act(async () => {
      superseded.reject(error);
    });

    // The shelf is still live and the title never reached it, so the reason is
    // reported rather than swallowed.
    expect(screen.getByRole("alert")).toHaveTextContent(
      publicShelfSaveErrorMessage(error),
    );
    expect(input).toHaveValue("新標題");

    // The newer write lands and clears the error text — but it carried expiry
    // only, so the title is still local-only and the notice says so.
    await act(async () => {
      newer.resolve({ shelf: { ...SHELF, expiresDays: 7 } });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(UNSAVED_NOTICE);
    expect(
      screen.getByRole("button", { name: "重試儲存" }),
    ).toBeInTheDocument();
  });
});

/** Write only when the local value differs from the server's: an echoed `expiresDays` silently restarts
 *  the shelf's expiry clock, and every request spends the per-userId write ceiling. */
describe("PublicShareDialog · writes with nothing to say are skipped", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spends no request when the title is typed back to the stored value before the debounce fires", async () => {
    const apiClient = makeActiveApiClient();
    const input = await renderSettledDialog(apiClient);

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "新標題" } });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.change(input, { target: { value: SHELF.title } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();
    expect(input).toHaveValue(SHELF.title);
    expectNoUnsavedNotice();
  });

  // React delivers a <select> change event unconditionally, so re-picking the current option reaches the
  // handler — the divergence check stops it becoming a PUT that restarts the expiry clock.
  it("spends no request when the expiry selection resolves to the value already stored", async () => {
    const apiClient = makeActiveApiClient();
    await renderSettledDialog(apiClient);

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), {
        target: { value: String(SHELF.expiresDays) },
      });
    });

    expect(apiClient.updatePublicShelf).not.toHaveBeenCalled();
    expectNoUnsavedNotice();
  });
});

/** The server sanitizes titles beyond `trim()` (zero-width and control characters); adopting the value
 *  it confirms keeps the unsaved notice from sticking on a title the user can never retype. */
describe("PublicShareDialog · server-sanitized titles", () => {
  beforeEach(() => {
    vi.mocked(useIsMobile).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts the title the server stored and clears the divergence", async () => {
    const updatePublicShelf = vi
      .fn()
      .mockResolvedValue({ shelf: { ...SHELF, title: "書櫃" } });
    const input = await renderSettledDialog(
      makeActiveApiClient({ updatePublicShelf }),
    );

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: `書櫃${ZWSP}` } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // What the user typed is what gets sent — the client never pre-sanitizes.
    expect(updatePublicShelf).toHaveBeenCalledWith("user-1", "shelf-1", {
      title: `書櫃${ZWSP}`,
    });
    expect(input).toHaveValue("書櫃");
    expectNoUnsavedNotice();
  });

  it("leaves the field alone when the user typed again while the write was in flight", async () => {
    const deferred = createDeferred<{ shelf: PublicShelf }>();
    const updatePublicShelf = vi.fn().mockReturnValue(deferred.promise);
    const input = await renderSettledDialog(
      makeActiveApiClient({ updatePublicShelf }),
    );

    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: `書櫃${ZWSP}` } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    // Still typing while the confirmation is on its way back.
    fireEvent.change(input, { target: { value: "書櫃 v2" } });

    await act(async () => {
      deferred.resolve({ shelf: { ...SHELF, title: "書櫃" } });
    });

    // A landing response must never clobber a field being edited.
    expect(input).toHaveValue("書櫃 v2");
  });
});
