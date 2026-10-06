import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App, type View } from "@/dialog/App";
import { ApiClient } from "@/api/client";
import { familyGoneNoticeText } from "@/dialog/familyGoneNotice";
import {
  USER_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  FAMILY_ID_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
  API_ENDPOINT_KEY,
  AUTO_SYNC_INTERVAL_KEY,
  DEFAULT_API_ENDPOINT,
} from "@/constants";
import type { AccountIdentity } from "@/content/accountIdentity";

/**
 * App × the boot-time Readmoo account check (issue #271).
 *
 * The extension's identity lives in the browser profile, so when a DIFFERENT
 * Readmoo account is logged in on the page the Dialog must not act as the stored
 * one: it shows the account-mismatch screen with nothing behind it mounted — no
 * shelves, no settings, no API call — and its single action resets this device
 * only. `match` / `unknown` boot into the main view as before.
 *
 * The check itself navigates the host SPA (covered in
 * tests/unit/dialog/accountIdentityCheck.test.ts), so here it is mocked; the
 * reset path (familyBindingReset.ts) and storage (tests/setup.ts) are real.
 * Every "nothing loaded" assertion has a `match` companion in which the same
 * fetch stub and child stubs DO observe the main view loading.
 */

vi.mock("@/dialog/accountIdentityCheck", () => ({
  checkAccountIdentity: vi.fn(),
  verifyAccountIdentity: vi.fn(),
  cachedIdentity: vi.fn(),
  markAccountConfirmed: vi.fn(),
  forgetAccountConfirmation: vi.fn(),
}));

vi.mock("@/dialog/Onboarding", () => ({
  Onboarding: ({
    onFamilyJoined,
  }: {
    onFamilyJoined: (id: string, userId: string) => void;
  }) => (
    <div data-testid="onboarding">
      <button onClick={() => onFamilyJoined("fam-new", "user-new")}>
        Mock Join
      </button>
    </div>
  ),
}));

// Reaches the manual-sync recheck the way useBookSync does: via the context.
vi.mock("@/dialog/PersonalShelf", async () => {
  const { useAccountCheck } = await import("@/dialog/AccountCheckContext");
  return {
    PersonalShelf: () => {
      const { recheck } = useAccountCheck();
      return (
        <div data-testid="personal-shelf">
          <button onClick={() => void recheck()}>Mock Recheck</button>
        </div>
      );
    },
  };
});

vi.mock("@/dialog/FamilyShelf", () => ({
  FamilyShelf: () => <div data-testid="family-shelf">FamilyShelf</div>,
}));

vi.mock("@/dialog/FamilySettings", () => ({
  FamilySettings: () => <div data-testid="family-settings">Settings</div>,
}));

vi.mock("@/dialog/DialogFooter", () => ({
  DialogFooter: () => <div data-testid="dialog-footer">footer</div>,
}));

import {
  checkAccountIdentity,
  verifyAccountIdentity,
  cachedIdentity,
  markAccountConfirmed,
  forgetAccountConfirmation,
} from "@/dialog/accountIdentityCheck";

const OLD_USER = "a".repeat(64);
const CUSTOM_ENDPOINT = "https://custom.workers.dev";
const MISMATCH_HEADING = "目前登入的讀墨帳號與設定時不同";
const RESET_BUTTON = "改用這個帳號重新設定";
const RESET_FAILED = "這個瀏覽器上的設定沒有清除成功，請再試一次。";

/** Every local key that names the old account (familyBindingReset.ts). */
const ACCOUNT_LOCAL_KEYS = [
  USER_ID_KEY,
  FAMILY_ID_KEY,
  AUTH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
  LAST_SYNC_AT_KEY,
  DISPLAY_NAME_KEY,
  USER_EMAIL_KEY,
  PERSONAL_BOOKS_CACHE_KEY,
];

/** Account A as onboarded on this browser profile. */
async function seedStoredAccount(): Promise<void> {
  await chrome.storage.local.set({
    [USER_ID_KEY]: OLD_USER,
    [FAMILY_ID_KEY]: "fam-1",
    [AUTH_TOKEN_KEY]: "tok",
    [TOKEN_EXPIRES_AT_KEY]: Date.now() + 60 * 60 * 1000,
    [LAST_SYNC_AT_KEY]: 1,
    [DISPLAY_NAME_KEY]: "帳號 A",
    [USER_EMAIL_KEY]: "a@example.com",
    [PERSONAL_BOOKS_CACHE_KEY]: { books: [] },
    [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
    [AUTO_SYNC_INTERVAL_KEY]: "daily",
  });
  await chrome.storage.sync.set({ [FAMILY_ID_KEY]: "fam-1" });
}

/** Capture the ApiClient App creates in its useRef (see App.test.tsx). */
async function captureApiClients() {
  const instances: ApiClient[] = [];
  const OrigConstructor = ApiClient;
  const spy = vi
    .spyOn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("@/api/client")) as any,
      "ApiClient",
    )
    .mockImplementation((...args: unknown[]) => {
      const instance = new OrigConstructor(...(args as [string?]));
      instances.push(instance);
      return instance;
    });
  return { instances, restore: () => spy.mockRestore() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending effects and promise chains settle (no fake timers in this file). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function expectNoMainView(): void {
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(screen.queryByTestId("family-shelf")).not.toBeInTheDocument();
  expect(screen.queryByTestId("personal-shelf")).not.toBeInTheDocument();
  expect(screen.queryByTestId("family-settings")).not.toBeInTheDocument();
}

describe("App account check (#271)", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let restoreClients: (() => void) | null = null;

  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.clearAllMocks();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    vi.mocked(checkAccountIdentity).mockResolvedValue("match");
    vi.mocked(verifyAccountIdentity).mockResolvedValue("match");
    vi.mocked(cachedIdentity).mockReturnValue("match");
    // Never settles: the main view's loads are observable as calls, and no
    // response can cascade into reauth / family-removed flows.
    fetchMock = vi.fn(() => new Promise(() => {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await seedStoredAccount();
  });

  afterEach(async () => {
    restoreClients?.();
    restoreClients = null;
    globalThis.fetch = originalFetch;
    vi.mocked(chrome.runtime.sendMessage).mockReset();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });

  async function renderApp(identity: AccountIdentity) {
    vi.mocked(checkAccountIdentity).mockResolvedValue(identity);
    const { instances, restore } = await captureApiClients();
    restoreClients = restore;
    const onViewChange = vi.fn<(view: View) => void>();
    const utils = render(<App onViewChange={onViewChange} />);
    return { ...utils, onViewChange, clients: instances };
  }

  describe("another Readmoo account is logged in (mismatch)", () => {
    it("shows the mismatch screen with nothing behind it and makes no API call", async () => {
      const { onViewChange } = await renderApp("mismatch");

      const heading = await screen.findByRole("heading", {
        name: MISMATCH_HEADING,
      });
      expect(screen.getByRole("alert")).toContainElement(heading);
      await settle();

      expect(checkAccountIdentity).toHaveBeenCalledWith(
        OLD_USER,
        expect.any(AbortSignal),
      );
      expectNoMainView();
      expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
      expect(onViewChange).toHaveBeenCalledWith("account-mismatch");
      expect(onViewChange).not.toHaveBeenCalledWith("main");
      expect(fetchMock).not.toHaveBeenCalled();
      // A mismatch is never recorded as a confirmation.
      expect(markAccountConfirmed).not.toHaveBeenCalled();
    });

    it("resets this device only and lands on onboarding", async () => {
      const { onViewChange, clients } = await renderApp("mismatch");
      await screen.findByRole("heading", { name: MISMATCH_HEADING });
      const leaveFamily = vi.spyOn(clients[0], "leaveFamily");

      fireEvent.click(screen.getByRole("button", { name: RESET_BUTTON }));

      await waitFor(() => {
        expect(screen.getByTestId("onboarding")).toBeInTheDocument();
      });
      await settle();

      const local = await chrome.storage.local.get(null);
      for (const key of [...ACCOUNT_LOCAL_KEYS, API_ENDPOINT_KEY]) {
        expect(local).not.toHaveProperty(key);
      }
      // Positive companion: the store is readable and device prefs survive.
      expect(local).toEqual({ [AUTO_SYNC_INTERVAL_KEY]: "daily" });
      expect(await chrome.storage.sync.get(null)).toEqual({});

      // The old account keeps its family: no leave, no request of any kind.
      expect(leaveFamily).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(clients[0].getEndpoint()).toBe(DEFAULT_API_ENDPOINT);
      expect(forgetAccountConfirmation).toHaveBeenCalled();
      expect(screen.queryByText(MISMATCH_HEADING)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onViewChange).toHaveBeenLastCalledWith("onboarding");
    });

    it("stays on the mismatch screen with an error when the local reset fails", async () => {
      const { clients } = await renderApp("mismatch");
      await screen.findByRole("heading", { name: MISMATCH_HEADING });
      await waitFor(() => {
        expect(clients[0].getEndpoint()).toBe(CUSTOM_ENDPOINT);
      });
      vi.mocked(chrome.storage.local.remove).mockImplementationOnce(() =>
        Promise.reject(new Error("storage unavailable")),
      );

      fireEvent.click(screen.getByRole("button", { name: RESET_BUTTON }));

      expect(await screen.findByText(RESET_FAILED)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: MISMATCH_HEADING }),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
      expectNoMainView();
      // The button is usable again for a retry.
      expect(screen.getByRole("button", { name: RESET_BUTTON })).toBeEnabled();
      // Nothing half-done: the old account and its endpoint are still in place.
      const local = await chrome.storage.local.get([
        USER_ID_KEY,
        API_ENDPOINT_KEY,
      ]);
      expect(local).toEqual({
        [USER_ID_KEY]: OLD_USER,
        [API_ENDPOINT_KEY]: CUSTOM_ENDPOINT,
      });
      expect(clients[0].getEndpoint()).toBe(CUSTOM_ENDPOINT);
      expect(forgetAccountConfirmation).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("the stored account is logged in, or it cannot be told", () => {
    it("match: boots into the main view and loads it", async () => {
      const { onViewChange } = await renderApp("match");

      expect(await screen.findByRole("tablist")).toBeInTheDocument();
      expect(screen.getByTestId("family-shelf")).toBeInTheDocument();
      expect(screen.queryByText(MISMATCH_HEADING)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(onViewChange).toHaveBeenCalledWith("main");
      });
      // Same fetch stub as the mismatch cases: here the main view does load.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      expect(markAccountConfirmed).toHaveBeenCalledWith(OLD_USER);
    });

    it("unknown: still boots into the main view", async () => {
      const { onViewChange } = await renderApp("unknown");

      expect(await screen.findByRole("tablist")).toBeInTheDocument();
      expect(screen.getByTestId("family-shelf")).toBeInTheDocument();
      expect(screen.queryByText(MISMATCH_HEADING)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(onViewChange).toHaveBeenCalledWith("main");
      });
      // Unknown is not a confirmation.
      expect(markAccountConfirmed).not.toHaveBeenCalled();
    });

    it("records the account onboarding just derived as confirmed", async () => {
      await chrome.storage.local.clear();
      await chrome.storage.sync.clear();
      await renderApp("match");
      await screen.findByTestId("onboarding");
      expect(checkAccountIdentity).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Mock Join"));

      expect(await screen.findByRole("tablist")).toBeInTheDocument();
      // Onboarding's pre-upload re-check (#281) left a cached match for it.
      expect(cachedIdentity).toHaveBeenCalledWith("user-new");
      expect(markAccountConfirmed).toHaveBeenCalledWith("user-new");
    });

    it("shows the mismatch screen when onboarding's check found another account (#284)", async () => {
      await chrome.storage.local.clear();
      await chrome.storage.sync.clear();
      vi.mocked(cachedIdentity).mockReturnValue("mismatch");
      const { onViewChange } = await renderApp("match");
      await screen.findByTestId("onboarding");

      fireEvent.click(screen.getByText("Mock Join"));

      expect(
        await screen.findByRole("heading", { name: MISMATCH_HEADING }),
      ).toBeInTheDocument();
      await settle();
      expect(cachedIdentity).toHaveBeenCalledWith("user-new");
      expectNoMainView();
      expect(onViewChange).toHaveBeenLastCalledWith("account-mismatch");
      expect(onViewChange).not.toHaveBeenCalledWith("main");
      expect(markAccountConfirmed).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("while the check is running", () => {
    it("stays on the loading view until the check resolves", async () => {
      const pending = deferred<AccountIdentity>();
      vi.mocked(checkAccountIdentity).mockReturnValue(pending.promise);
      const onViewChange = vi.fn<(view: View) => void>();

      render(<App onViewChange={onViewChange} />);
      await waitFor(() => {
        expect(checkAccountIdentity).toHaveBeenCalled();
      });
      await settle();

      expect(screen.getByText("載入中...")).toBeInTheDocument();
      expectNoMainView();
      expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
      expect(onViewChange.mock.calls).toEqual([["loading"]]);
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        pending.resolve("match");
      });
      expect(await screen.findByRole("tablist")).toBeInTheDocument();
    });

    it("aborts the check on unmount and applies nothing afterwards", async () => {
      const pending = deferred<AccountIdentity>();
      let signal: AbortSignal | undefined;
      vi.mocked(checkAccountIdentity).mockImplementation((_userId, s) => {
        signal = s;
        return pending.promise;
      });

      const { unmount } = render(<App />);
      await waitFor(() => {
        expect(checkAccountIdentity).toHaveBeenCalled();
      });
      expect(signal?.aborted).toBe(false);

      unmount();
      expect(signal?.aborted).toBe(true);

      // checkAccountIdentity never rejects; a late answer must be dropped.
      await act(async () => {
        pending.resolve("match");
      });
      await settle();
      expect(markAccountConfirmed).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  /**
   * The check takes >= 1.5 s, so the family can be torn down (ApiClient's
   * onFamilyRemoved) while it is in flight; its late answer must not undo that.
   * Positive companions: "stays on the loading view until the check resolves"
   * (a deferred boot `match` DOES reach the main view) and the main-view recheck
   * case below (a late `mismatch` DOES show the blocking screen).
   */
  describe("a family teardown during an in-flight check", () => {
    const GONE_CODE = "FAMILY_NOT_FOUND";

    function expectOnboardingWithNotice(): void {
      expect(screen.getByTestId("onboarding")).toBeInTheDocument();
      expect(
        within(screen.getByRole("alert")).getByText(
          familyGoneNoticeText(GONE_CODE),
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(MISMATCH_HEADING)).not.toBeInTheDocument();
      expectNoMainView();
    }

    it.each<AccountIdentity>(["match", "mismatch"])(
      "boot check resolving %s after the teardown keeps onboarding",
      async (identity) => {
        const pending = deferred<AccountIdentity>();
        // Queued before render: the boot call is the first and only one here.
        vi.mocked(checkAccountIdentity).mockReturnValueOnce(pending.promise);
        const { onViewChange, clients } = await renderApp("match");
        await waitFor(() => {
          expect(checkAccountIdentity).toHaveBeenCalled();
        });
        expect(screen.getByText("載入中...")).toBeInTheDocument();

        await act(async () => {
          clients[0].onFamilyRemoved!({ errorCode: GONE_CODE });
        });
        expectOnboardingWithNotice();

        await act(async () => {
          pending.resolve(identity);
        });
        await settle();

        expectOnboardingWithNotice();
        expect(markAccountConfirmed).not.toHaveBeenCalled();
        expect(onViewChange).not.toHaveBeenCalledWith("main");
        expect(onViewChange).not.toHaveBeenCalledWith("account-mismatch");
        expect(onViewChange).toHaveBeenLastCalledWith("onboarding");
      },
    );

    /** Boot to the main view as `unknown`, then start a manual-sync recheck. */
    async function startRecheckFromMainView() {
      const pending = deferred<AccountIdentity>();
      const rendered = await renderApp("unknown");
      expect(await screen.findByRole("tablist")).toBeInTheDocument();
      await settle();
      vi.mocked(verifyAccountIdentity).mockReturnValueOnce(pending.promise);

      fireEvent.click(screen.getByRole("tab", { name: /個人書櫃/ }));
      fireEvent.click(await screen.findByText("Mock Recheck"));
      // The recheck is the uncached one (#277); the cached check ran at boot only.
      expect(verifyAccountIdentity).toHaveBeenCalledOnce();
      expect(verifyAccountIdentity).toHaveBeenCalledWith(OLD_USER);
      expect(checkAccountIdentity).toHaveBeenCalledOnce();
      return { ...rendered, pending };
    }

    it("a late recheck mismatch on the main view shows the mismatch screen", async () => {
      const { onViewChange, pending } = await startRecheckFromMainView();

      await act(async () => {
        pending.resolve("mismatch");
      });

      expect(
        await screen.findByRole("heading", { name: MISMATCH_HEADING }),
      ).toBeInTheDocument();
      expectNoMainView();
      expect(onViewChange).toHaveBeenLastCalledWith("account-mismatch");
    });

    it("a recheck mismatch landing after the teardown keeps onboarding", async () => {
      const { onViewChange, clients, pending } =
        await startRecheckFromMainView();

      await act(async () => {
        clients[0].onFamilyRemoved!({ errorCode: GONE_CODE });
      });
      expectOnboardingWithNotice();

      await act(async () => {
        pending.resolve("mismatch");
      });
      await settle();

      expectOnboardingWithNotice();
      expect(onViewChange).not.toHaveBeenCalledWith("account-mismatch");
      expect(onViewChange).toHaveBeenLastCalledWith("onboarding");
    });
  });
});
