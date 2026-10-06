import { webcrypto } from "node:crypto";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { App, type View } from "@/dialog/App";
import { deriveUserId } from "moo-family-bookshelf-shared/crypto/hash";
import { clearReadmooEmailCookie } from "../helpers/readmooEmailCookie";

/**
 * App × onboarding's pre-upload account check (issue #284).
 *
 * Onboarding re-reads `#/me` through verifyAccountIdentity right before its
 * first book upload (#281) and then hands over to App via onFamilyJoined. When
 * that check found ANOTHER Readmoo account (another tab switched accounts), App
 * must show the account-mismatch screen — not enter the main view as the stored
 * account.
 *
 * Unlike AppAccountCheck.test.tsx, the account-check module
 * (dialog/accountIdentityCheck.ts) is REAL here, so this fails if either its
 * remembered mismatch or App's use of it is reverted. Only the host page is
 * stubbed: readMePageProfile (the `#/me` navigation + scrape) returns a chosen
 * email, and the real deriveUserId / compareAccountIdentity decide the result.
 * No login cookie is set, so the cookie veto never applies. The Onboarding stub
 * reproduces onboardingFlow.ts: verify, then onFamilyJoined regardless.
 */

vi.mock("@/content/hashNavigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/hashNavigation")>()),
  readMePageProfile: vi.fn(),
}));

// Filled in beforeAll: the stored account onboarding just derived.
const joined = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/dialog/Onboarding", async () => {
  const { verifyAccountIdentity } =
    await import("@/dialog/accountIdentityCheck");
  return {
    Onboarding: ({
      onFamilyJoined,
    }: {
      onFamilyJoined: (id: string, userId: string) => void;
    }) => (
      <div data-testid="onboarding">
        <button
          onClick={async () => {
            await verifyAccountIdentity(joined.userId);
            onFamilyJoined("fam-new", joined.userId);
          }}
        >
          Mock Join
        </button>
      </div>
    ),
  };
});

vi.mock("@/dialog/PersonalShelf", () => ({
  PersonalShelf: () => <div data-testid="personal-shelf">PersonalShelf</div>,
}));

vi.mock("@/dialog/FamilyShelf", () => ({
  FamilyShelf: () => <div data-testid="family-shelf">FamilyShelf</div>,
}));

vi.mock("@/dialog/FamilySettings", () => ({
  FamilySettings: () => <div data-testid="family-settings">Settings</div>,
}));

vi.mock("@/dialog/DialogFooter", () => ({
  DialogFooter: () => <div data-testid="dialog-footer">footer</div>,
}));

import { readMePageProfile } from "@/content/hashNavigation";
import { forgetAccountConfirmation } from "@/dialog/accountIdentityCheck";

const EMAIL_STORED = "account-a@example.com";
const EMAIL_OTHER = "account-b@example.com";
// Sync: AccountMismatchScreen.tsx heading (pinned in AppAccountCheck.test.tsx).
const MISMATCH_HEADING = "目前登入的讀墨帳號與設定時不同";

beforeAll(async () => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
  joined.userId = await deriveUserId(EMAIL_STORED);
});

function expectNoMainView(): void {
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(screen.queryByTestId("family-shelf")).not.toBeInTheDocument();
  expect(screen.queryByTestId("personal-shelf")).not.toBeInTheDocument();
  expect(screen.queryByTestId("family-settings")).not.toBeInTheDocument();
}

describe("App after onboarding's pre-upload account check (#284)", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // The check's results live at module level for the whole page load.
    forgetAccountConfirmation();
    clearReadmooEmailCookie();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    vi.clearAllMocks();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    // Never settles: the main view's loads are observable as calls only.
    fetchMock = vi.fn(() => new Promise(() => {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    forgetAccountConfirmation();
    globalThis.fetch = originalFetch;
    vi.mocked(chrome.runtime.sendMessage).mockReset();
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });

  /** Boot with no family (→ onboarding), then join with the page on `email`. */
  async function joinWithPageAccount(email: string | null) {
    vi.mocked(readMePageProfile).mockResolvedValue({
      email,
      displayName: "",
    });
    const onViewChange = vi.fn<(view: View) => void>();
    render(<App onViewChange={onViewChange} />);
    await screen.findByTestId("onboarding");

    await act(async () => {
      fireEvent.click(screen.getByText("Mock Join"));
    });
    // The real check ran exactly once, against the page.
    await waitFor(() => {
      expect(readMePageProfile).toHaveBeenCalledOnce();
    });
    return { onViewChange };
  }

  it("shows the mismatch screen when another Readmoo account is logged in", async () => {
    const { onViewChange } = await joinWithPageAccount(EMAIL_OTHER);

    const heading = await screen.findByRole("heading", {
      name: MISMATCH_HEADING,
    });
    expect(screen.getByRole("alert")).toContainElement(heading);
    // Onboarding already created/joined the family on the server before this
    // screen, so it must not claim nothing changed (#284 review).
    expect(
      screen.queryByText(/沒有讀取或變更任何資料/),
    ).not.toBeInTheDocument();
    expectNoMainView();
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onViewChange).toHaveBeenLastCalledWith("account-mismatch");
    });
    expect(onViewChange).not.toHaveBeenCalledWith("main");
    // Nothing behind the screen loaded as the stored account.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, string | null]>([
    ["the stored account is logged in (match)", EMAIL_STORED],
    ["the page shows no email (unknown)", null],
  ])("enters the main view when %s", async (_case, email) => {
    const { onViewChange } = await joinWithPageAccount(email);

    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByText(MISMATCH_HEADING)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onViewChange).toHaveBeenLastCalledWith("main");
    });
    expect(onViewChange).not.toHaveBeenCalledWith("account-mismatch");
    // Same fetch stub as the mismatch case: here the main view does load.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
