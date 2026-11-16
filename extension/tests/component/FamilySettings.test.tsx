import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { FamilySettings, FamilySettingsProps } from "@/dialog/FamilySettings";
import { FamilyDataProvider } from "@/dialog/FamilyDataContext";
import {
  buildRemovedNoticeText,
  buildUnkickedNoticeText,
} from "@/dialog/UnkickNotice";
import { BoolFlag, validateEndpointUrl, type ApiClient } from "@/api/client";
import { rateLimitedMessage } from "@/dialog/verificationMessages";
import { REJOIN_WAIT_NOTE } from "moo-family-bookshelf-shared/unkick/messages";
import { encodeSyncCode } from "moo-family-bookshelf-shared/crypto/syncCode";
import {
  API_ENDPOINT_KEY,
  buildInviteUrl,
  DECLINED_FAMILY_ENDPOINT_KEY,
  DEFAULT_API_ENDPOINT,
  DISPLAY_NAME_KEY,
  FAMILY_ID_KEY,
  SYNC_ARCHIVED_KEY,
  STORE_PAGE_CHIP_ENABLED_KEY,
  STORE_PAGE_HOST_GRANTED_KEY,
  STORE_PAGE_INDEX_KEY,
  USER_ID_KEY,
} from "@/constants";
import { buildStorePageIndex } from "moo-family-bookshelf-shared/storePage/index";
import {
  STORE_CHIP_NOT_GRANTED_DIALOG,
  STORE_CHIP_OPEN_OPTIONS_FALLBACK,
} from "@/options/storePageChipMessages";
import {
  ACCOUNT_SETTINGS_LOCAL_ONLY,
  ACCOUNT_SETTINGS_SAVE_FAILED,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import { createAccountSettingsServer } from "../helpers/accountSettingsServer";

/**
 * FamilySettings: display name, members, sync code / invite, leaving, the un-kick entry, the
 * family endpoint-switch confirmation, and the 新書預設開放 switch (#238, a server-side setting read
 * once per mount through `getPersonalBooks` and saved through `updateNewBookDefault`).
 *
 * QR stub: FamilySettings mounts InviteQrCode, which does a real `await import("qrcode")` plus a PNG
 * encode on every mount (its effect keys on [inviteUrl] — src/dialog/InviteQrCode.tsx). Nothing here
 * asserts on QR output, so the encoder is stubbed instead of paying module resolution + encoding ~60
 * times per file run, a cost that lands inside every readiness barrier. Shape mirrors
 * tests/component/QrCodeLink.test.tsx.
 *
 * Self-leave outcomes: a retried, half-failed self-leave gets 404 MEMBER_NOT_FOUND once the Worker
 * has finished the cleanup — a completed leave; keeping the local family would let silent recovery
 * re-join it. 404 FAMILY_NOT_FOUND is the same outcome: a sole-owner dissolve that half-failed after
 * deleting the family record answers it on every retry, and keeping the local family would strand the
 * user on a family that no longer exists. The opposite case (a real refusal renders its error and
 * does NOT call onLeave) is pinned by "shows the localized back-off copy when leaving is rate limited".
 *
 * Departure binding: the leave block gets `useBoundDepartureLeave`'s callback, which reads the stored
 * userId / familyId after a successful leave and calls `onLeave` only while they are still this
 * viewer's (no family left, with the same or no userId, also counts — another tab already left) —
 * so `onLeave` now lands asynchronously, and every case expecting it seeds `VIEWER_BINDING`
 * (`mockStorageGet` alone serves only the display name). Storage naming another family or account
 * gets no `onLeave`; those cases wait for the binding read itself, then for it to settle, before the
 * negative assertion. The delete block keeps the raw `onLeave` and receives `familyId`, because its
 * hook checks the binding BEFORE clearing storage; a stateful mock whose `clear` empties the binding
 * proves it by counting exactly one binding read (a bound callback would read again after the clear).
 *
 * Account settings (#460): FamilyDataProvider mounts the real `AccountSettingsProvider`, so the
 * 同步封存書籍 / store-page chip / 自動同步頻率 / 按鈕大小 switches save through the mock client's
 * `accountSettings` (the in-memory server of tests/helpers/accountSettingsServer.tsx). A mock client
 * without it reads as a refused save — the switch springs back with 「儲存失敗，請稍後再試」 — so
 * every case asserting a stored value passes one. storage.local is written only after the server
 * confirmed, and only while the stored userId is the viewer's, so those cases seed `USER_ID_KEY`
 * too. A 404 on the open-time read shows `ACCOUNT_SETTINGS_LOCAL_ONLY` and keeps changes local.
 *
 * Store-page chip switch (#313, `useStorePageChip`): an account setting the options page also
 * writes. The Dialog has no permissions API, so it reads the background's mirror
 * `moo:storePageHostGranted`: granted → switching on saves TRUE and, only when the family shelf is
 * already loaded, writes the index built from that shelf (the viewer's own books excluded); not
 * granted and off → it asks the background to open the options page and shows a fallback hint when
 * that fails; on for the account but not granted in this browser → the not-granted copy plus a
 * 「前往設定頁授權」 button (the revoked copy 「授權已被收回…」 is gone, decision 6). The shelf
 * comes from the REAL
 * FamilyDataProvider, so "loaded" is driven through the mock client's `getFamilyBookshelf` (a
 * never-resolving promise keeps it loading); `act` around render plus settle ticks is the readiness
 * barrier. The index goes through the binding-guarded writer, which re-reads the switch and the
 * stored userId / familyId after the switch write, so the indexing cases use a STATEFUL storage mock
 * (`seedStatefulStorage`: `set` lands in a map that `get` reads) seeded with the stored binding; a
 * binding naming another family (or none) must get the switch written but no index — the shelf on
 * screen may belong to a family the user has just left.
 *
 * Un-kick entry: a removal writes a 6-hour server-side block on rejoining, so the owner gets an entry
 * to lift it right where the removal happened. It is owner-only (the endpoint refuses anyone else)
 * and must outlive a failed member refresh, because by then the removal — and the block — already
 * happened. After the block is lifted the member can rejoin and be removed again; the backend then
 * writes a new tombstone and the notice card must return to idle, handing the 「解除移除限制」 entry
 * back to the owner — a card stuck on the previous success copy would make the owner believe the
 * second block is lifted too.
 *
 * Endpoint switch: the family record's `apiEndpoint` is chosen by the family OWNER and pushed to every
 * member, so adopting it silently would let the owner redirect another member's auth token and full
 * book list (unshared books included) to a host of their choosing; the Settings tab asks first (the
 * security contract lives in src/dialog/useEndpointSwitch.ts). The mock client is STATEFUL like the
 * real ApiClient: `setEndpoint` moves what `getEndpoint` reports, through the production validator so
 * the stored value is canonical — useEndpointSwitch re-reads `getEndpoint()` after a successful switch
 * to decide what the sync code advertises, so a frozen getter would hide exactly the drift the
 * "sync code follows the adopted endpoint" block exists to catch; `opts.setEndpoint` overrides the
 * whole behaviour (a client refusing the target) and then nothing moves. Whether the panel appears is
 * a THREE-deep effect conjunction: the members fetch (FamilyDataProvider → membersState "ready"),
 * useEndpointSwitch's declined-marker storage read, and the effect joining the two into `pending`.
 * `findByTestId` is no barrier for that — it polls with the act environment disabled and ends on a bare
 * `setTimeout(0)`, so a node missing at poll time says nothing about whether React owes the commit,
 * and under CPU contention the chain outlives the 1s budget. Only `act` guarantees pending effects
 * flushed on exit. The sync code's `@host` must describe the endpoint THIS device ADOPTED, never the
 * record's advertised value: it is what the member hands to the next person (and re-scans onto their
 * own phone), and building it from the record would make a member who DECLINED a switch still
 * distribute the refused endpoint — the invitee lands on the untrusted host while the decliner never
 * does, so the refusal would protect only the person who made it. A confirm first reads the stored
 * familyId (#498): the block's storage mock returns the family the screen is rendered with, so the
 * switch goes through, and each 確認切換 click settles inside `act`; a stored familyId naming another
 * family refuses the confirm with the binding-gone notice and moves nothing.
 *
 * Invite-URL copy button: the square icon button beside 「邀請成員加入家庭」 copies ONLY
 * `buildInviteUrl(syncCode)` and, for 2 s, renames itself 「已複製邀請網址」. Its name 「複製邀請網址」 is a
 * substring of the copied state, so every query is an exact-name role query plus a negative on the
 * sibling variant. Queries are scoped to the 家庭同步碼 block because the 手機登入與驗證 section on the
 * same screen has its own 「複製連結」 button (the mobile-login link, `QrCodeLink`), a different action.
 * The 2-second reset runs on fake timers, so the file-level `afterEach` restores real timers.
 */

// Fake timers exclude RTL waiters; tripwire per tests rule "Fake timers exclude RTL waiters".
afterEach(() => {
  vi.useRealTimers();
});

// Remove-confirm question + shared rejoin-wait note, rendered in one element.
// Literal pin: tests/component/MemberList.test.tsx → "rejoin-wait note".
const REMOVE_CONFIRM_TEXT = `確定要移除此成員？${REJOIN_WAIT_NOTE}`;

// InviteQrCode imports and encodes a real QR on every mount; nothing here asserts on it, so stub the
// encoder (mirrors QrCodeLink.test.tsx). See the file header, "QR stub".
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,stub"),
  },
}));

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    createFamily: vi.fn(),
    joinFamily: vi.fn(),
    leaveFamily: vi.fn().mockResolvedValue({ data: { ok: true } }),
    removeMember: vi.fn().mockResolvedValue({ data: { ok: true } }),
    unkickMember: vi
      .fn()
      .mockResolvedValue({ data: { cleared: BoolFlag.TRUE } }),
    transferOwnership: vi.fn().mockResolvedValue({ data: { ok: true } }),
    // A record without the setting: the 新書預設開放 switch loads off and ready ("new book default toggle").
    getPersonalBooks: vi.fn().mockResolvedValue({ data: { books: [] } }),
    updatePersonalBooks: vi.fn(),
    updateNewBookDefault: vi
      .fn()
      .mockResolvedValue({ data: { ok: true, newBookDefaultShared: 1 } }),
    updateDisplayName: vi.fn().mockResolvedValue({
      data: { userId: "user-abc12345", displayName: "" },
    }),
    getFamilyMembers: vi.fn().mockResolvedValue({
      data: {
        familyId: "fam-123",
        ownerId: "user-abc12345",
        members: [
          { userId: "user-abc12345", displayName: "小明" },
          { userId: "user-def67890", displayName: "" },
        ],
        maxMembers: 6,
        createdAt: "2026-01-01",
      },
    }),
    getFamilyBookshelf: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-123", members: [] } }),
    deleteAccount: vi.fn().mockResolvedValue({ data: { ok: true } }),
    // Default endpoint + no family apiEndpoint = nothing to confirm, so the endpoint-switch panel stays
    // out of unrelated tests; "family endpoint switch confirmation" overrides this pair.
    getEndpoint: vi.fn().mockReturnValue(DEFAULT_API_ENDPOINT),
    setEndpoint: vi.fn(),
    setAuthToken: vi.fn(),
    updateFamilyEndpoint: vi
      .fn()
      .mockResolvedValue({ data: { familyId: "fam-123", apiEndpoint: null } }),
    getVerifyMethod: vi
      .fn()
      .mockResolvedValue({ data: { method: "none", prompted: 0 } }),
    setVerifyMethod: vi.fn().mockResolvedValue({ data: { ok: true } }),
    generateOtp: vi.fn().mockResolvedValue({
      data: { code: "123456", expiresAt: Date.now() + 300000 },
    }),
    // An empty account-settings record (#460); cases that inspect saves pass their own server.
    accountSettings: createAccountSettingsServer().api,
    ...overrides,
  } as unknown as ApiClient;
}

function renderFamilySettings(props: Partial<FamilySettingsProps> = {}) {
  const defaultProps: FamilySettingsProps = {
    familyId: "fam-123",
    userId: "user-abc12345",
    apiClient: createMockApiClient(),
    onLeave: vi.fn(),
  };
  const merged = { ...defaultProps, ...props };
  return render(
    <FamilyDataProvider
      familyId={merged.familyId}
      userId={merged.userId}
      apiClient={merged.apiClient}
    >
      <FamilySettings {...merged} />
    </FamilyDataProvider>,
  );
}

/** Stub `chrome.storage.local.get` to resolve the display name plus any `extra` entries (e.g. a recorded
 *  endpoint-switch refusal) for every key set — callers pick the keys they asked for. */
function mockStorageGet(extra: Record<string, unknown> = {}) {
  vi.mocked(chrome.storage.local.get).mockImplementation(
    (_keys: unknown, callback?: (result: Record<string, unknown>) => void) => {
      const result = { [DISPLAY_NAME_KEY]: "小明", ...extra };
      if (typeof callback === "function") {
        callback(result);
      }
      return Promise.resolve(result) as unknown as void;
    },
  );
}

/** The stored binding of the rendered viewer (`renderFamilySettings`' default props); a successful leave
 *  or delete clears it only while storage still holds it. See the file header, "Departure binding". */
const VIEWER_BINDING = {
  [USER_ID_KEY]: "user-abc12345",
  [FAMILY_ID_KEY]: "fam-123",
};

/** Calls of the departure-binding read (`departureBindingIsCurrent`) so far. */
function bindingReads(): number {
  return vi
    .mocked(chrome.storage.local.get)
    .mock.calls.filter(
      ([keys]) =>
        Array.isArray(keys) &&
        keys.length === 2 &&
        keys[0] === USER_ID_KEY &&
        keys[1] === FAMILY_ID_KEY,
    ).length;
}

describe("FamilySettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return an encryption key and display name from storage
    mockStorageGet();
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
    vi.mocked(chrome.storage.sync.set).mockResolvedValue();
  });

  // Helper: find the display name section by its label
  function getDisplayNameSection() {
    return screen.getByText("顯示名稱").closest("div")!.parentElement!;
  }

  function enterEditMode() {
    const section = getDisplayNameSection();
    const pencilBtn = section.querySelector("button")!;
    fireEvent.click(pencilBtn);
  }

  it("shows display name section with loaded value in display mode", async () => {
    renderFamilySettings();

    expect(screen.getByText("顯示名稱")).toBeInTheDocument();
    expect(
      screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
    ).toBeInTheDocument();

    // New inline edit: display mode shows text, not input
    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });
    // No input visible in display mode
    expect(
      screen.queryByPlaceholderText("輸入顯示名稱"),
    ).not.toBeInTheDocument();
  });

  it("enters edit mode when pencil icon is clicked", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    // Now input should be visible
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  it("exits edit mode and reverts on cancel", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });

    // Click cancel (X) button — second button in the edit row
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[1]); // X button

    // Should be back in display mode
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("輸入顯示名稱"),
      ).not.toBeInTheDocument();
    });
  });

  it("saves display name via API and to local/sync storage", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "大明" },
    });

    // Click check (confirm) button — first button in the edit row
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[0]); // Check button

    await waitFor(() => {
      expect(apiClient.updateDisplayName).toHaveBeenCalledWith(
        "fam-123",
        "user-abc12345",
        "大明",
      );
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [DISPLAY_NAME_KEY]: "大明",
      });
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({
        [DISPLAY_NAME_KEY]: "大明",
      });
    });
  });

  it("shows API displayName for all members in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      // Owner has displayName "小明" from API — appears in both display name editor and member list
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      // Other member has empty displayName, falls back to userId slice
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });
  });

  it("shows sync code section", async () => {
    renderFamilySettings();

    expect(screen.getByText("家庭同步碼")).toBeInTheDocument();
    // Wait for sync code to load
    await waitFor(() => {
      expect(screen.getByText(/moo-fam-123/)).toBeInTheDocument();
    });
  });

  // A drag would hand the invite QR's data URL to a page `dragstart` listener (#362).
  it("renders the invite QR image as not draggable", async () => {
    renderFamilySettings();

    const img = await screen.findByAltText("掃描此 QR Code 邀請家人加入書櫃");
    expect(img.getAttribute("draggable")).toBe("false");
  });

  it("shows copy sync code button", async () => {
    renderFamilySettings();

    expect(screen.getByText("複製同步碼")).toBeInTheDocument();

    // Wait for the member fetch to avoid an act() warning; "小明" is in both the display-name editor
    // and the member list, hence getAllByText.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("invite button copies URL with #invite= format containing sync code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderFamilySettings();

    // Wait for members to load so async effects settle.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getByText("邀請成員加入家庭"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("#invite="),
      );
    });

    // The invite URL should contain the encoded sync code
    const calledWith = writeText.mock.calls[0][0] as string;
    expect(calledWith).toContain("#invite=");
  });

  // See the file header → "Invite-URL copy button".
  describe("invite-URL copy button (複製邀請網址)", () => {
    const EXPECTED_URL = buildInviteUrl(
      encodeSyncCode({ familyId: "fam-123" }),
    );
    let writeText: ReturnType<typeof vi.fn>;
    let previousClipboard: Clipboard | undefined;

    beforeEach(() => {
      previousClipboard = navigator.clipboard;
      writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
    });

    afterEach(() => {
      Object.assign(navigator, { clipboard: previousClipboard });
    });

    async function renderSettled() {
      await act(async () => {
        renderFamilySettings();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    function syncCodeBlock() {
      const block = screen
        .getByText("家庭同步碼")
        .closest(".moo-settings__block");
      expect(block).not.toBeNull();
      return within(block as HTMLElement);
    }

    it("copies exactly the invite URL and renames itself 已複製邀請網址", async () => {
      await renderSettled();
      const block = syncCodeBlock();

      await act(async () => {
        fireEvent.click(block.getByRole("button", { name: "複製邀請網址" }));
      });

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toBe(EXPECTED_URL);
      const copiedButton = block.getByRole("button", {
        name: "已複製邀請網址",
      });
      expect(copiedButton).toHaveAttribute("title", "複製邀請網址");
      expect(
        block.queryByRole("button", { name: "複製邀請網址" }),
      ).not.toBeInTheDocument();
      // The message button beside it is untouched.
      expect(
        block.getByRole("button", { name: "邀請成員加入家庭" }),
      ).toBeInTheDocument();
      expect(block.queryByText("已複製邀請連結")).not.toBeInTheDocument();
    });

    it("stays 複製邀請網址 when only the invite-message button is pressed", async () => {
      await renderSettled();
      const block = syncCodeBlock();

      await act(async () => {
        fireEvent.click(
          block.getByRole("button", { name: "邀請成員加入家庭" }),
        );
      });

      expect(
        block.getByRole("button", { name: "已複製邀請連結" }),
      ).toBeInTheDocument();
      expect(
        block.getByRole("button", { name: "複製邀請網址" }),
      ).toBeInTheDocument();
      expect(
        block.queryByRole("button", { name: "已複製邀請網址" }),
      ).not.toBeInTheDocument();
    });

    it("returns to 複製邀請網址 after 2 seconds", async () => {
      await renderSettled();
      const block = syncCodeBlock();
      vi.useFakeTimers();

      await act(async () => {
        fireEvent.click(block.getByRole("button", { name: "複製邀請網址" }));
      });
      expect(
        block.getByRole("button", { name: "已複製邀請網址" }),
      ).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(
        block.getByRole("button", { name: "已複製邀請網址" }),
      ).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(
        block.getByRole("button", { name: "複製邀請網址" }),
      ).toBeInTheDocument();
      expect(
        block.queryByRole("button", { name: "已複製邀請網址" }),
      ).not.toBeInTheDocument();
    });

    it("is not the mobile-login 複製連結 button on the same screen", async () => {
      await renderSettled();
      const block = syncCodeBlock();

      // The QR section's button exists on screen, just not in this block.
      expect(
        screen.getByRole("button", { name: "複製連結" }),
      ).toBeInTheDocument();
      expect(
        block.getByRole("button", { name: "複製邀請網址" }),
      ).toBeInTheDocument();
      expect(
        block.queryByRole("button", { name: "複製連結" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows member list after loading", async () => {
    renderFamilySettings();

    // Wait for member loading to complete
    await waitFor(() => {
      // "小明" appears in both display name editor and member list
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // The current user should have a "(你)" indicator
    expect(screen.getByText("(你)")).toBeInTheDocument();
  });

  it("shows leave family button", async () => {
    renderFamilySettings();

    expect(screen.getByText("離開家庭")).toBeInTheDocument();

    // Wait for async member fetch to complete to avoid act() warning.
    // "小明" appears in both the display-name editor and the member list.
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("two-step confirmation: clicking leave shows confirm and cancel", async () => {
    renderFamilySettings();

    // Click the leave button
    fireEvent.click(screen.getByText("離開家庭"));

    // Should now show the confirmation dialog
    await waitFor(() => {
      expect(screen.getByText("確定要離開嗎？")).toBeInTheDocument();
      expect(screen.getByText("確定離開")).toBeInTheDocument();
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Original button should be gone
    expect(screen.queryByText("離開家庭")).not.toBeInTheDocument();
  });

  it("cancel button returns to idle leave state", async () => {
    renderFamilySettings();

    // Enter confirming state
    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("取消")).toBeInTheDocument();
    });

    // Click cancel
    fireEvent.click(screen.getByText("取消"));

    // Should return to idle state with the leave button visible again
    await waitFor(() => {
      expect(screen.getByText("離開家庭")).toBeInTheDocument();
      expect(screen.queryByText("確定離開")).not.toBeInTheDocument();
    });
  });

  it("shows (管理員) badge next to the owner in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("(管理員)")).toBeInTheDocument();
    });
  });

  it("owner sees remove and transfer buttons for other members", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });
  });

  it("non-owner does not see remove or transfer buttons", async () => {
    const apiClient = createMockApiClient({
      getFamilyMembers: vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-123",
          ownerId: "user-def67890",
          members: [
            { userId: "user-abc12345", displayName: "小明" },
            { userId: "user-def67890", displayName: "大明" },
          ],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      }),
    });

    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("大明")).toBeInTheDocument();
    });

    expect(screen.queryByText("移除")).not.toBeInTheDocument();
    expect(screen.queryByText("轉移管理權")).not.toBeInTheDocument();
  });

  it("shows confirmation when clicking remove button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText(REMOVE_CONFIRM_TEXT)).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls removeMember API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    const callsBefore = vi.mocked(apiClient.getFamilyMembers).mock.calls.length;

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(apiClient.removeMember).toHaveBeenCalledWith(
        "fam-123",
        "user-def67890",
      );
    });

    // fetchMembers should be called at least once more after the action
    await waitFor(() => {
      expect(
        vi.mocked(apiClient.getFamilyMembers).mock.calls.length,
      ).toBeGreaterThan(callsBefore);
    });
  });

  it("shows confirmation when clicking transfer button", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "確定要將管理權轉移給此成員？轉移後你將無法移除其他成員。",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("確定")).toBeInTheDocument();
    });
  });

  it("calls transferOwnership API and refreshes on confirm", async () => {
    const apiClient = createMockApiClient();
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("轉移管理權")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("轉移管理權"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    const callsBefore = vi.mocked(apiClient.getFamilyMembers).mock.calls.length;

    await waitFor(() => {
      expect(apiClient.transferOwnership).toHaveBeenCalledWith(
        "fam-123",
        "user-abc12345",
        "user-def67890",
        undefined,
        undefined,
      );
    });

    await waitFor(() => {
      expect(
        vi.mocked(apiClient.getFamilyMembers).mock.calls.length,
      ).toBeGreaterThan(callsBefore);
    });
  });

  it("shows owner-specific error when owner tries to leave", async () => {
    const apiClient = createMockApiClient({
      leaveFamily: vi.fn().mockResolvedValue({
        error: { code: "OWNER_CANNOT_LEAVE", message: "Owner cannot leave" },
      }),
    });
    renderFamilySettings({ apiClient });

    fireEvent.click(screen.getByText("離開家庭"));

    await waitFor(() => {
      expect(screen.getByText("確定離開")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定離開"));

    await waitFor(() => {
      expect(
        screen.getByText("管理者必須先轉移管理權才能離開家庭"),
      ).toBeInTheDocument();
    });
  });

  /** A 404 MEMBER_NOT_FOUND / FAMILY_NOT_FOUND on a retried self-leave is a completed leave, so the local
   *  family must go. See the file header, "Self-leave outcomes". */
  it.each([
    ["MEMBER_NOT_FOUND", "目標使用者不是家庭成員"],
    ["FAMILY_NOT_FOUND", "Family not found"],
  ])(
    "treats %s on self-leave as a completed leave",
    async (code, serverMessage) => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockResolvedValue({
          error: { code, message: serverMessage },
        }),
      });
      mockStorageGet(VIEWER_BINDING);
      const onLeave = vi.fn();
      renderFamilySettings({ apiClient, onLeave });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(onLeave).toHaveBeenCalledOnce();
      });
      expect(screen.queryByText(serverMessage)).not.toBeInTheDocument();
      expect(
        screen.queryByText("離開家庭失敗，請稍後再試"),
      ).not.toBeInTheDocument();
    },
  );

  it("cancel confirmation hides confirm dialog in member list", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText(REMOVE_CONFIRM_TEXT)).toBeInTheDocument();
    });

    // Find the cancel button inside the MemberList confirmation (not the leave cancel)
    const cancelButtons = screen.getAllByText("取消");
    fireEvent.click(cancelButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText(REMOVE_CONFIRM_TEXT)).not.toBeInTheDocument();
    });
  });

  it("shows error when removeMember API fails", async () => {
    const apiClient = createMockApiClient({
      removeMember: vi.fn().mockResolvedValue({
        error: { code: "FORBIDDEN", message: "權限不足" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(screen.getByText("移除")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("移除"));

    await waitFor(() => {
      expect(screen.getByText("確定")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("確定"));

    await waitFor(() => {
      expect(screen.getByText("權限不足")).toBeInTheDocument();
    });
  });

  /** A removal writes a 6-hour rejoin block; the owner-only entry to lift it must outlive a failed member
   *  refresh. See the file header, "Un-kick entry". */
  describe("un-kick entry after a removal", () => {
    const SELF_ID = "user-abc12345";
    const REMOVED_ID = "user-def67890";
    const THIRD_ID = "user-ghi00000";

    function membersResponse(ownerId: string) {
      return {
        data: {
          familyId: "fam-123",
          ownerId,
          members: [
            { userId: SELF_ID, displayName: "小明" },
            { userId: REMOVED_ID, displayName: "大明" },
            { userId: THIRD_ID, displayName: "阿華" },
          ],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      };
    }

    /** `removedAt` makes the notice's `key` unique PER REMOVAL, and the real clock can put two removals in
     *  one millisecond: pinned so the second-removal case exercises the remount, not timing luck. */
    let restoreClock: (() => void) | null = null;

    afterEach(() => {
      restoreClock?.();
      restoreClock = null;
    });

    function controlClock(startMs: number) {
      let now = startMs;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      restoreClock = () => spy.mockRestore();
      return {
        advance(ms: number) {
          now += ms;
        },
      };
    }

    /** Confirm removing 大明 (first non-self member). `act` lets removal → parent report → refresh settle
     *  before asserting; `waitFor` alone can pass on an intermediate render (the confirm hides 移除). */
    async function removeSecondMember() {
      await waitFor(() => {
        expect(screen.getAllByText("移除").length).toBeGreaterThan(0);
      });
      fireEvent.click(screen.getAllByText("移除")[0]);

      await waitFor(() => {
        expect(screen.getByText("確定")).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByText("確定"));
      });
    }

    it("does not offer the entry before anything was removed", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue(membersResponse(SELF_ID)),
      });
      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("大明")).toBeInTheDocument();
      });

      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });

    it("offers to lift the rejoin block, naming the member just removed", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue(membersResponse(SELF_ID)),
      });
      renderFamilySettings({ apiClient });

      await removeSecondMember();

      await waitFor(() => {
        expect(
          screen.getByText(buildRemovedNoticeText("大明")),
        ).toBeInTheDocument();
      });
    });

    it("lifts the block for the removed member when the entry is used", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue(membersResponse(SELF_ID)),
      });
      renderFamilySettings({ apiClient });

      await removeSecondMember();

      await waitFor(() => {
        expect(
          screen.getByText(buildRemovedNoticeText("大明")),
        ).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "解除移除限制" }));

      await waitFor(() => {
        expect(apiClient.unkickMember).toHaveBeenCalledWith(
          "fam-123",
          REMOVED_ID,
        );
      });
      await waitFor(() => {
        expect(
          screen.getByText(buildUnkickedNoticeText("大明")),
        ).toBeInTheDocument();
      });
    });

    /** A rejoined member removed again gets a new tombstone; the card must return to idle and hand back
     *  「解除移除限制」. See the file header, "Un-kick entry". */
    it("returns the entry to idle when the same member is removed again", async () => {
      const clock = controlClock(1_700_000_000_000);
      const apiClient = createMockApiClient({
        // The refreshed list still holds 大明 — standing in for them rejoining
        // with the sync code once the first block was lifted.
        getFamilyMembers: vi.fn().mockResolvedValue(membersResponse(SELF_ID)),
      });
      renderFamilySettings({ apiClient });

      await removeSecondMember();
      await waitFor(() => {
        expect(
          screen.getByText(buildRemovedNoticeText("大明")),
        ).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "解除移除限制" }));
      });
      expect(
        screen.getByText(buildUnkickedNoticeText("大明")),
      ).toBeInTheDocument();

      // 大明 rejoined; a minute later the owner removes them a second time.
      clock.advance(60_000);
      await removeSecondMember();

      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(buildUnkickedNoticeText("大明")),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "解除移除限制" }),
      ).toBeEnabled();
      // Only the FIRST block was lifted — the new one still stands.
      expect(apiClient.unkickMember).toHaveBeenCalledTimes(1);
    });

    it("keeps the entry when the member-list refresh fails afterwards", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi
          .fn()
          .mockResolvedValueOnce(membersResponse(SELF_ID))
          .mockResolvedValue({
            error: { code: "SERVER_ERROR", message: "載入成員失敗" },
          }),
      });
      renderFamilySettings({ apiClient });

      await removeSecondMember();

      // The list itself is gone (error state), but the block was still written.
      await waitFor(() => {
        expect(screen.getByText("載入成員失敗")).toBeInTheDocument();
      });
      expect(
        screen.getByText(buildRemovedNoticeText("大明")),
      ).toBeInTheDocument();
    });

    it("withdraws the entry if the caller is no longer the owner", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi
          .fn()
          .mockResolvedValueOnce(membersResponse(SELF_ID))
          // Ownership moved to 阿華 while the removal was in flight — only the
          // owner may lift the block, so the entry must not linger.
          .mockResolvedValue(membersResponse(THIRD_ID)),
      });
      renderFamilySettings({ apiClient });

      await removeSecondMember();

      // The refresh landed and the confirm dialog closed, so a still-owner
      // would be showing 移除 again here — its absence is the ownership change.
      await waitFor(() => {
        expect(apiClient.getFamilyMembers).toHaveBeenCalledTimes(2);
      });
      expect(screen.queryByText("確定")).not.toBeInTheDocument();
      expect(screen.queryByText("移除")).not.toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });

    it("does not offer the entry to a non-owner member", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue(membersResponse(THIRD_ID)),
      });
      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("大明")).toBeInTheDocument();
      });

      expect(screen.queryByText("移除")).not.toBeInTheDocument();
      expect(
        screen.queryByText(buildRemovedNoticeText("大明")),
      ).not.toBeInTheDocument();
    });
  });

  it("shows error when updateDisplayName API fails", async () => {
    const apiClient = createMockApiClient({
      updateDisplayName: vi.fn().mockResolvedValue({
        error: { code: "VALIDATION_ERROR", message: "名稱過長" },
      }),
    });
    renderFamilySettings({ apiClient });

    await waitFor(() => {
      expect(
        screen.getByText("此名稱僅用於家庭書櫃，不影響讀墨帳號"),
      ).toBeInTheDocument();
    });

    enterEditMode();

    fireEvent.change(screen.getByPlaceholderText("輸入顯示名稱"), {
      target: { value: "新名稱" },
    });

    // Click check (confirm) button
    const editButtons = screen
      .getByPlaceholderText("輸入顯示名稱")
      .parentElement!.querySelectorAll("button");
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("名稱過長")).toBeInTheDocument();
    });
    // Should stay in edit mode after error
    expect(screen.getByPlaceholderText("輸入顯示名稱")).toBeInTheDocument();
  });

  describe("sync archived toggle", () => {
    it("shows '同步封存書籍' toggle switch", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(
          screen.getByRole("switch", { name: "同步封存書籍" }),
        ).toBeInTheDocument();
      });
    });

    it("shows description text for the toggle, saying it is shared with the PWA", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(
          screen.getByText(
            "啟用後，同步時會一併讀取已封存的書籍。這個設定跟著帳號，擴充功能和手機版共用。",
          ),
        ).toBeInTheDocument();
      });
      expect(
        screen.queryByText("啟用後，同步時會一併讀取已封存的書籍"),
      ).not.toBeInTheDocument();
    });

    it("toggle is initially off (aria-checked false)", async () => {
      // No SYNC_ARCHIVED_KEY in storage.local, so the flag reads as 0.
      renderFamilySettings();

      await waitFor(() => {
        expect(chrome.storage.local.get).toHaveBeenCalledWith(
          expect.arrayContaining([SYNC_ARCHIVED_KEY]),
        );
      });
      const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    it("toggle reflects an initial stored value of 1", async () => {
      mockStorageGet({ [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE });

      renderFamilySettings();

      await waitFor(() => {
        const toggle = screen.getByRole("switch", { name: "同步封存書籍" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
      });
    });

    /** Render with the viewer's binding stored, the account-settings server attached, and settle. */
    async function renderWithServer(
      server = createAccountSettingsServer(),
    ): Promise<HTMLElement> {
      mockStorageGet(VIEWER_BINDING);
      await act(async () => {
        renderFamilySettings({
          apiClient: createMockApiClient({ accountSettings: server.api }),
        });
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      vi.mocked(chrome.storage.local.set).mockClear();
      return screen.getByRole("switch", { name: "同步封存書籍" });
    }

    async function clickAndSettle(toggle: HTMLElement) {
      await act(async () => {
        fireEvent.click(toggle);
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    it("clicking toggle saves it to the server, then writes 1 to storage.local, not to the background", async () => {
      const server = createAccountSettingsServer();
      const toggle = await renderWithServer(server);
      expect(toggle.getAttribute("aria-checked")).toBe("false");

      await clickAndSettle(toggle);

      expect(server.patch).toHaveBeenCalledWith("user-abc12345", {
        settings: { syncArchived: BoolFlag.TRUE },
      });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
      });
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_SYNC_ARCHIVED" }),
      );
    });

    it("switches back and shows the failure copy when the server refuses the save", async () => {
      expect(ACCOUNT_SETTINGS_SAVE_FAILED).toBe("儲存失敗，請稍後再試");
      const server = createAccountSettingsServer();
      server.patch.mockResolvedValueOnce({
        error: { code: "INTERNAL_ERROR", message: "boom" },
      });
      const toggle = await renderWithServer(server);

      await clickAndSettle(toggle);

      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(
        screen.getByText(ACCOUNT_SETTINGS_SAVE_FAILED),
      ).toBeInTheDocument();
      expect(
        vi
          .mocked(chrome.storage.local.set)
          .mock.calls.filter(
            ([items]) => SYNC_ARCHIVED_KEY in (items as object),
          ),
      ).toHaveLength(0);
    });

    it("says the settings stay in this browser and keeps the change on a server without the feature (404)", async () => {
      expect(ACCOUNT_SETTINGS_LOCAL_ONLY).toBe(
        "伺服器尚未支援設定連動，這些設定只存在這個瀏覽器",
      );
      const server = createAccountSettingsServer();
      server.get.mockResolvedValueOnce({
        error: { code: "NOT_FOUND", message: "Not Found" },
      });
      const toggle = await renderWithServer(server);

      expect(screen.getByText(ACCOUNT_SETTINGS_LOCAL_ONLY)).toBeInTheDocument();
      await clickAndSettle(toggle);

      expect(server.patch).not.toHaveBeenCalled();
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [SYNC_ARCHIVED_KEY]: BoolFlag.TRUE,
      });
      expect(
        screen.queryByText(ACCOUNT_SETTINGS_SAVE_FAILED),
      ).not.toBeInTheDocument();
    });

    it("shows no local-only notice when the server supports account settings", async () => {
      await renderWithServer();
      expect(
        screen.queryByText(ACCOUNT_SETTINGS_LOCAL_ONLY),
      ).not.toBeInTheDocument();
    });

    it("tells the user the frequency and button-size settings follow the account", async () => {
      await renderWithServer();

      expect(
        screen.getByText(
          "開啟個人書櫃時，距離上次同步超過這段時間就會自動同步；手動同步不受此限制。這個設定跟著帳號。",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "在讀墨頁面顯示的家庭書櫃按鈕大小。這個設定跟著帳號。",
        ),
      ).toBeInTheDocument();
    });
  });

  // #238. Copy is pinned against the production hook in
  // tests/unit/dialog/useFamilySettingsNewBookDefault.test.ts; keep these literals in sync with it.
  describe("new book default toggle (新書預設開放)", () => {
    const NEW_BOOK_SWITCH = { name: "新書預設開放" };
    const HINT =
      "打開後，同步時個人書櫃裡還沒有的書（例如新買的書、從封存移回書櫃的書）會自動開放給家人，也會出現在你的公開書櫃。第一次同步，或一次新增超過 100 本書時，不會自動開放，封存的書也不會";

    async function renderSettled(apiClient: ApiClient) {
      await act(async () => {
        renderFamilySettings({ apiClient });
      });
      // Let the mount read resolve and commit.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    function newBookSwitch() {
      return screen.getByRole("switch", NEW_BOOK_SWITCH);
    }

    it("is disabled with the hint-styled sync-first message when the user has no record yet", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockResolvedValue({ data: null }),
      });
      await renderSettled(apiClient);

      expect(newBookSwitch()).toBeDisabled();
      expect(newBookSwitch().getAttribute("aria-checked")).toBe("false");
      const message = screen.getByText("同步一次書單後就能設定");
      expect(message).toHaveClass("moo-settings__hint");
      expect(message).not.toHaveClass("moo-settings__error-text");
      fireEvent.click(newBookSwitch());
      expect(apiClient.updateNewBookDefault).not.toHaveBeenCalled();
    });

    it("renders off and enabled with its hint when the record has no setting yet", async () => {
      const apiClient = createMockApiClient();
      await renderSettled(apiClient);

      expect(apiClient.getPersonalBooks).toHaveBeenCalledWith("user-abc12345");
      expect(newBookSwitch().getAttribute("aria-checked")).toBe("false");
      expect(newBookSwitch()).toBeEnabled();
      expect(screen.getByText(HINT)).toBeInTheDocument();
      expect(
        screen.queryByText("載入設定失敗，請稍後再試"),
      ).not.toBeInTheDocument();
    });

    it("reflects a stored value of 1", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockResolvedValue({
          data: { books: [], newBookDefaultShared: BoolFlag.TRUE },
        }),
      });
      await renderSettled(apiClient);

      expect(newBookSwitch().getAttribute("aria-checked")).toBe("true");
    });

    it("is disabled while the setting is still loading", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockReturnValue(new Promise(() => {})),
      });
      await renderSettled(apiClient);

      expect(newBookSwitch()).toBeDisabled();
      fireEvent.click(newBookSwitch());
      expect(apiClient.updateNewBookDefault).not.toHaveBeenCalled();
    });

    it("saves TRUE through the API when switched on", async () => {
      const apiClient = createMockApiClient();
      await renderSettled(apiClient);

      fireEvent.click(newBookSwitch());
      expect(newBookSwitch().getAttribute("aria-checked")).toBe("true");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(apiClient.updateNewBookDefault).toHaveBeenCalledTimes(1);
      expect(apiClient.updateNewBookDefault).toHaveBeenCalledWith(
        "user-abc12345",
        BoolFlag.TRUE,
      );
      expect(newBookSwitch().getAttribute("aria-checked")).toBe("true");
      // It is a server setting, not a local one.
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ newBookDefaultShared: expect.anything() }),
      );
    });

    it("rolls back, disables the switch and shows the hint-styled unsupported message on a 404", async () => {
      const apiClient = createMockApiClient({
        updateNewBookDefault: vi.fn().mockResolvedValue({
          error: { code: "NOT_FOUND", message: "Not found" },
        }),
      });
      await renderSettled(apiClient);

      fireEvent.click(newBookSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(newBookSwitch().getAttribute("aria-checked")).toBe("false");
      expect(newBookSwitch()).toBeDisabled();
      const message = screen.getByText("伺服器尚未支援這個設定");
      expect(message).toHaveClass("moo-settings__hint");
      expect(message).not.toHaveClass("moo-settings__error-text");
    });

    it("rolls back and shows the error-styled retry message when the save fails", async () => {
      const apiClient = createMockApiClient({
        updateNewBookDefault: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "boom" },
        }),
      });
      await renderSettled(apiClient);

      fireEvent.click(newBookSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(newBookSwitch().getAttribute("aria-checked")).toBe("false");
      expect(newBookSwitch()).toBeEnabled();
      expect(screen.getByText("儲存失敗，請稍後再試")).toHaveClass(
        "moo-settings__error-text",
      );
    });

    it("stays disabled with the load-failed message when the read fails", async () => {
      const apiClient = createMockApiClient({
        getPersonalBooks: vi.fn().mockRejectedValue(new Error("offline")),
      });
      await renderSettled(apiClient);

      expect(newBookSwitch()).toBeDisabled();
      expect(newBookSwitch().getAttribute("aria-checked")).toBe("false");
      expect(screen.getByText("載入設定失敗，請稍後再試")).toHaveClass(
        "moo-settings__error-text",
      );
    });
  });

  // #313. See the file header → "Store-page chip switch".
  describe("store-page chip switch (在購買頁顯示家人開放的書)", () => {
    const STORE_SWITCH = { name: "在購買頁顯示家人開放的書" };
    const OWN_BOOK = "210000000000001";
    const SHARED_BOOK = "210000000000002";
    const UNSHARED_BOOK = "210000000000003";

    function book(bookId: string, isShared: BoolFlag) {
      return { bookId, title: `書 ${bookId}`, isShared };
    }

    /** The viewer and one member, each sharing a book; the member also has an unshared one. */
    const SHELF_MEMBERS = [
      {
        userId: "user-abc12345",
        displayName: "小明",
        lastUpdated: null,
        books: [book(OWN_BOOK, BoolFlag.TRUE)],
      },
      {
        userId: "user-def67890",
        displayName: "阿華",
        lastUpdated: null,
        books: [
          book(SHARED_BOOK, BoolFlag.TRUE),
          book(UNSHARED_BOOK, BoolFlag.FALSE),
        ],
      },
    ];

    /** A loaded shelf, and an account-settings server so the switch's saves land (see the header). */
    function shelfClient(server = createAccountSettingsServer()): ApiClient {
      return createMockApiClient({
        getFamilyBookshelf: vi.fn().mockResolvedValue({
          data: { familyId: "fam-123", members: SHELF_MEMBERS },
        }),
        accountSettings: server.api,
      });
    }

    async function renderSettled(apiClient: ApiClient) {
      await act(async () => {
        renderFamilySettings({ apiClient });
      });
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      }
    }

    function storeSwitch() {
      return screen.getByRole("switch", STORE_SWITCH);
    }

    function setCallsWith(key: string): Record<string, unknown>[] {
      return vi
        .mocked(chrome.storage.local.set)
        .mock.calls.map(([items]) => items as Record<string, unknown>)
        .filter((items) => key in items);
    }

    function openOptionsCalls() {
      return vi
        .mocked(chrome.runtime.sendMessage)
        .mock.calls.filter(
          ([message]) =>
            (message as { type?: string } | undefined)?.type ===
            "OPEN_OPTIONS_PAGE",
        );
    }

    /** The stored binding of the rendered viewer (`renderFamilySettings`' default props). */
    const BOUND = {
      [USER_ID_KEY]: "user-abc12345",
      [FAMILY_ID_KEY]: "fam-123",
    };

    /** `set` writes into a map that `get` returns (every entry, like `mockStorageGet`); granted, switch
     *  off. See the file header → "Store-page chip switch". */
    function seedStatefulStorage(binding: Record<string, unknown>) {
      const store: Record<string, unknown> = {
        [DISPLAY_NAME_KEY]: "小明",
        [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.TRUE,
        ...binding,
      };
      vi.mocked(chrome.storage.local.get).mockImplementation(((
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        const result = { ...store };
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result);
      }) as never);
      vi.mocked(chrome.storage.local.set).mockImplementation(((
        items: Record<string, unknown>,
      ) => {
        Object.assign(store, items);
        return Promise.resolve();
      }) as never);
    }

    afterEach(() => {
      vi.mocked(chrome.runtime.sendMessage).mockReset();
    });

    it("renders off with its hint by default", async () => {
      await renderSettled(shelfClient());

      expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      // Decision 12: one merged sentence about the per-browser grant, then that it follows the account.
      expect(
        screen.getByText(
          "開啟後，瀏覽讀墨書籍頁面時，書名下方會顯示哪位家人已開放這本書；每個瀏覽器第一次開啟都要在設定頁授權。這個設定跟著帳號。",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/第一次開啟需要在設定頁授權/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/每個瀏覽器要各自授權一次/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "前往設定頁授權" }),
      ).not.toBeInTheDocument();
    });

    it("switches on and indexes the loaded shelf, without the viewer, when granted", async () => {
      seedStatefulStorage(BOUND);
      await renderSettled(shelfClient());

      fireEvent.click(storeSwitch());

      await waitFor(() => {
        expect(setCallsWith(STORE_PAGE_INDEX_KEY)).toHaveLength(1);
      });
      expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      });
      const [written] = setCallsWith(STORE_PAGE_INDEX_KEY);
      const expected = buildStorePageIndex(
        [
          {
            userId: "user-abc12345",
            displayName: "小明",
            books: [{ bookId: OWN_BOOK }],
          },
          {
            userId: "user-def67890",
            displayName: "阿華",
            books: [{ bookId: SHARED_BOOK }],
          },
        ],
        "user-abc12345",
        "fam-123",
        new Date(),
      );
      expect(written[STORE_PAGE_INDEX_KEY]).toEqual({
        ...expected,
        updatedAt: expect.any(String),
      });
      expect(written[STORE_PAGE_INDEX_KEY]).toMatchObject({
        books: { [SHARED_BOOK]: ["阿華"] },
      });
      expect(openOptionsCalls()).toHaveLength(0);
    });

    it.each<[string, Record<string, unknown>]>([
      ["names another family", { ...BOUND, [FAMILY_ID_KEY]: "fam-999" }],
      ["names no family", { [USER_ID_KEY]: "user-abc12345" }],
    ])(
      "switches on but writes no index when the stored binding %s",
      async (_name, binding) => {
        seedStatefulStorage(binding);
        await renderSettled(shelfClient());

        fireEvent.click(storeSwitch());
        for (let i = 0; i < 3; i += 1) {
          await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
          });
        }

        expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
        });
        expect(setCallsWith(STORE_PAGE_INDEX_KEY)).toHaveLength(0);
      },
    );

    it("switches on without an index while the shelf is still loading", async () => {
      mockStorageGet({
        ...BOUND,
        [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.TRUE,
      });
      const apiClient = createMockApiClient({
        getFamilyBookshelf: vi.fn().mockReturnValue(new Promise(() => {})),
        accountSettings: createAccountSettingsServer().api,
      });
      await renderSettled(apiClient);

      fireEvent.click(storeSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
      });
      expect(setCallsWith(STORE_PAGE_INDEX_KEY)).toHaveLength(0);
    });

    it("asks the background to open the options page when not granted", async () => {
      vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: 1 });
      await renderSettled(shelfClient());

      fireEvent.click(storeSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(openOptionsCalls()).toEqual([[{ type: "OPEN_OPTIONS_PAGE" }]]);
      // The options page owns the switch from here: nothing is saved yet.
      expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      expect(setCallsWith(STORE_PAGE_CHIP_ENABLED_KEY)).toHaveLength(0);
      expect(
        screen.queryByText(STORE_CHIP_OPEN_OPTIONS_FALLBACK),
      ).not.toBeInTheDocument();
    });

    it.each<[string, () => void]>([
      [
        "rejects",
        () =>
          vi
            .mocked(chrome.runtime.sendMessage)
            .mockRejectedValue(new Error("Receiving end does not exist.")),
      ],
      [
        "gets no answer",
        () =>
          vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined),
      ],
      [
        "throws",
        () =>
          vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => {
            throw new Error("Extension context invalidated.");
          }),
      ],
    ])(
      "points at the toolbar icon when the request to open the options page %s",
      async (_name, breakMessage) => {
        await renderSettled(shelfClient());
        breakMessage();

        fireEvent.click(storeSwitch());
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });

        expect(STORE_CHIP_OPEN_OPTIONS_FALLBACK).toBe(
          "請點瀏覽器工具列上的墨家書櫃圖示，在設定頁開啟",
        );
        expect(
          screen.getByText(STORE_CHIP_OPEN_OPTIONS_FALLBACK),
        ).toBeInTheDocument();
        expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      },
    );

    it("drops the fallback hint and follows the switch once the options page grants and saves", async () => {
      await renderSettled(shelfClient());
      fireEvent.click(storeSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(
        screen.getByText(STORE_CHIP_OPEN_OPTIONS_FALLBACK),
      ).toBeInTheDocument();

      // The background mirrors the grant, the options page saves TRUE; every listener sees both.
      const listeners = vi
        .mocked(chrome.storage.onChanged.addListener)
        .mock.calls.map(
          ([fn]) => fn as unknown as (c: unknown, area: string) => void,
        );
      await act(async () => {
        for (const listener of listeners) {
          listener(
            {
              [STORE_PAGE_HOST_GRANTED_KEY]: { newValue: BoolFlag.TRUE },
              [STORE_PAGE_CHIP_ENABLED_KEY]: { newValue: BoolFlag.TRUE },
            },
            "local",
          );
        }
      });

      expect(
        screen.queryByText(STORE_CHIP_OPEN_OPTIONS_FALLBACK),
      ).not.toBeInTheDocument();
      expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
    });

    it("switches off and writes FALSE", async () => {
      mockStorageGet({
        ...BOUND,
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
        [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.TRUE,
      });
      const server = createAccountSettingsServer({
        storePageChipEnabled: BoolFlag.TRUE,
      });
      await renderSettled(shelfClient(server));
      expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
      vi.mocked(chrome.storage.local.set).mockClear();

      fireEvent.click(storeSwitch());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      expect(server.record.storePageChipEnabled).toBe(BoolFlag.FALSE);
      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.FALSE,
      });
      expect(setCallsWith(STORE_PAGE_INDEX_KEY)).toHaveLength(0);
      expect(openOptionsCalls()).toHaveLength(0);
    });

    it("switches back, shows the failure copy and writes no index when the server refuses", async () => {
      seedStatefulStorage(BOUND);
      const server = createAccountSettingsServer();
      server.patch.mockResolvedValueOnce({
        error: { code: "INTERNAL_ERROR", message: "boom" },
      });
      await renderSettled(shelfClient(server));

      fireEvent.click(storeSwitch());
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
      }

      expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getByText(ACCOUNT_SETTINGS_SAVE_FAILED),
      ).toBeInTheDocument();
      expect(setCallsWith(STORE_PAGE_CHIP_ENABLED_KEY)).toHaveLength(0);
      expect(setCallsWith(STORE_PAGE_INDEX_KEY)).toHaveLength(0);
    });

    describe("on for the account but not granted in this browser", () => {
      function seedOnNotGranted() {
        mockStorageGet({
          ...BOUND,
          [STORE_PAGE_CHIP_ENABLED_KEY]: BoolFlag.TRUE,
          [STORE_PAGE_HOST_GRANTED_KEY]: BoolFlag.FALSE,
        });
      }

      it("shows the not-granted copy and 前往設定頁授權, never the revoked wording", async () => {
        seedOnNotGranted();
        await renderSettled(
          shelfClient(
            createAccountSettingsServer({
              storePageChipEnabled: BoolFlag.TRUE,
            }),
          ),
        );

        expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
        expect(STORE_CHIP_NOT_GRANTED_DIALOG).toBe(
          "這個瀏覽器還沒授權，請到設定頁授權",
        );
        expect(
          screen.getByText(STORE_CHIP_NOT_GRANTED_DIALOG),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "前往設定頁授權" }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/授權已被收回/)).not.toBeInTheDocument();
        expect(
          screen.queryByText(/請關閉後再開啟一次/),
        ).not.toBeInTheDocument();
      });

      it("opens the options page from 前往設定頁授權 and saves nothing", async () => {
        vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: 1 });
        seedOnNotGranted();
        const server = createAccountSettingsServer({
          storePageChipEnabled: BoolFlag.TRUE,
        });
        await renderSettled(shelfClient(server));
        vi.mocked(chrome.storage.local.set).mockClear();

        fireEvent.click(screen.getByRole("button", { name: "前往設定頁授權" }));
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });

        expect(openOptionsCalls()).toEqual([[{ type: "OPEN_OPTIONS_PAGE" }]]);
        expect(server.patch).not.toHaveBeenCalled();
        expect(setCallsWith(STORE_PAGE_CHIP_ENABLED_KEY)).toHaveLength(0);
        expect(storeSwitch()).toHaveAttribute("aria-checked", "true");
      });

      it("turns the switch off for the account when it is pressed", async () => {
        seedOnNotGranted();
        const server = createAccountSettingsServer({
          storePageChipEnabled: BoolFlag.TRUE,
        });
        await renderSettled(shelfClient(server));

        fireEvent.click(storeSwitch());
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });

        expect(server.patch).toHaveBeenCalledWith("user-abc12345", {
          settings: { storePageChipEnabled: BoolFlag.FALSE },
        });
        expect(storeSwitch()).toHaveAttribute("aria-checked", "false");
        expect(openOptionsCalls()).toHaveLength(0);
        expect(
          screen.queryByRole("button", { name: "前往設定頁授權" }),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("members loading error", () => {
    it("shows error message when getFamilyMembers fails", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "無法載入成員" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("無法載入成員")).toBeInTheDocument();
      });
    });

    it("shows retry button when members fail to load", async () => {
      const apiClient = createMockApiClient({
        getFamilyMembers: vi.fn().mockResolvedValue({
          error: { code: "INTERNAL_ERROR", message: "載入失敗" },
        }),
      });

      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
        expect(screen.getByText("重試")).toBeInTheDocument();
      });
    });

    it("retry button re-fetches members", async () => {
      const successData = {
        data: {
          familyId: "fam-123",
          ownerId: "user-abc12345",
          members: [{ userId: "user-abc12345", displayName: "小明" }],
          maxMembers: 6,
          createdAt: "2026-01-01",
        },
      };
      const errorResponse = {
        error: { code: "INTERNAL_ERROR", message: "載入失敗" },
      };
      const getFamilyMembers = vi
        .fn()
        .mockResolvedValueOnce(errorResponse)
        .mockResolvedValue(successData);

      const apiClient = createMockApiClient({ getFamilyMembers });
      renderFamilySettings({ apiClient });

      await waitFor(() => {
        expect(screen.getByText("載入失敗")).toBeInTheDocument();
      });

      const callsBefore = getFamilyMembers.mock.calls.length;

      fireEvent.click(screen.getByText("重試"));

      await waitFor(() => {
        expect(screen.getByText("小明")).toBeInTheDocument();
      });

      // Verify retry caused additional call(s)
      expect(getFamilyMembers.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("updates member display name on chrome.storage.onChanged", async () => {
    renderFamilySettings();

    // Wait for members to load
    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("user-def")).toBeInTheDocument();
    });

    // Get the listener registered on chrome.storage.onChanged
    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener)
      .mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Simulate storage change for displayName
    act(() => {
      listener(
        { [DISPLAY_NAME_KEY]: { newValue: "大明", oldValue: "小明" } },
        "local",
      );
    });

    // Both the display-name section AND the member list should reflect "大明"
    // because both are now sourced from the same FamilyDataContext members state.
    await waitFor(() => {
      expect(screen.getAllByText("大明").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("ignores chrome.storage.onChanged from non-local area", async () => {
    renderFamilySettings();

    await waitFor(() => {
      expect(screen.getAllByText("小明").length).toBeGreaterThanOrEqual(1);
    });

    const addListenerCalls = vi.mocked(chrome.storage.onChanged.addListener)
      .mock.calls;
    const listener = addListenerCalls[addListenerCalls.length - 1][0];

    // Fire from "sync" area — should be ignored
    act(() => {
      listener(
        { [DISPLAY_NAME_KEY]: { newValue: "不應出現", oldValue: "小明" } },
        "sync",
      );
    });

    expect(screen.queryByText("不應出現")).not.toBeInTheDocument();
  });

  describe("leave family errors", () => {
    it("shows generic error when leave throws an exception", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue(new Error("Network down")),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("Network down")).toBeInTheDocument();
      });

      // Should return to idle state after error
      await waitFor(() => {
        expect(screen.getByText("離開家庭")).toBeInTheDocument();
      });
    });

    it("handles non-Error exception during leave", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockRejectedValue("string error"),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(
          screen.getByText("離開家庭失敗，請稍後再試"),
        ).toBeInTheDocument();
      });
    });

    /** The Worker rate-limits `DELETE /api/family/:id/member/:uid` (429 RATE_LIMITED, optional `retryAfter`)
     *  with English text, so leave renders the production builder's copy (pinned in verificationMessages.test.ts). */
    it("shows the localized back-off copy when leaving is rate limited", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockResolvedValue({
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            retryAfter: 90,
          },
        }),
      });
      const onLeave = vi.fn();
      renderFamilySettings({ apiClient, onLeave });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText(rateLimitedMessage(90))).toBeInTheDocument();
      });
      expect(screen.queryByText("Too many requests")).not.toBeInTheDocument();
      // A refused leave must not look like it succeeded.
      expect(onLeave).not.toHaveBeenCalled();
      expect(screen.getByText("離開家庭")).toBeInTheDocument();
    });

    it("shows the static back-off copy when the 429 carried no retryAfter", async () => {
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockResolvedValue({
          error: { code: "RATE_LIMITED", message: "Too many requests" },
        }),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText(rateLimitedMessage(null))).toBeInTheDocument();
      });
    });

    it("calls onLeave after successful leave", async () => {
      mockStorageGet(VIEWER_BINDING);
      const onLeave = vi.fn();
      renderFamilySettings({ onLeave });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(onLeave).toHaveBeenCalledOnce();
      });
    });

    it.each([
      ["another family", { ...VIEWER_BINDING, [FAMILY_ID_KEY]: "fam-999" }],
      ["another account", { ...VIEWER_BINDING, [USER_ID_KEY]: "user-other" }],
    ])(
      "does not call onLeave after a successful leave when storage now holds %s",
      async (_label, stored) => {
        mockStorageGet(stored);
        const apiClient = createMockApiClient();
        const onLeave = vi.fn();
        renderFamilySettings({ apiClient, onLeave });

        fireEvent.click(screen.getByText("離開家庭"));
        await waitFor(() => {
          expect(screen.getByText("確定離開")).toBeInTheDocument();
        });
        const readsBefore = bindingReads();
        fireEvent.click(screen.getByText("確定離開"));

        // Barrier: the leave succeeded and its binding read ran; then let that read settle.
        await waitFor(() => {
          expect(apiClient.leaveFamily).toHaveBeenCalledWith(
            "fam-123",
            "user-abc12345",
            undefined,
          );
          expect(bindingReads()).toBe(readsBefore + 1);
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(onLeave).not.toHaveBeenCalled();
      },
    );

    it("shows 離開中... during leave process", async () => {
      let resolveLeave: (value: unknown) => void;
      const apiClient = createMockApiClient({
        leaveFamily: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveLeave = resolve;
            }),
        ),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("離開家庭"));

      await waitFor(() => {
        expect(screen.getByText("確定離開")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定離開"));

      await waitFor(() => {
        expect(screen.getByText("離開中...")).toBeInTheDocument();
      });

      // Resolve to clean up
      resolveLeave!({ data: { ok: true } });
    });
  });

  describe("delete account", () => {
    it("shows 移除帳戶 button", async () => {
      renderFamilySettings();

      await waitFor(() => {
        expect(screen.getByText("移除帳戶")).toBeInTheDocument();
      });
    });

    it("shows confirmation dialog when clicking delete button", async () => {
      renderFamilySettings();

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });
    });

    it("calls deleteAccount API and onLeave on confirm", async () => {
      mockStorageGet(VIEWER_BINDING);
      const apiClient = createMockApiClient();
      const onLeave = vi.fn();
      renderFamilySettings({ apiClient, onLeave });

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定移除"));

      await waitFor(() => {
        // A `none` account confirms without a current secret (#396).
        expect(apiClient.deleteAccount).toHaveBeenCalledWith(
          "user-abc12345",
          undefined,
        );
        expect(onLeave).toHaveBeenCalled();
      });
    });

    /** The delete block gets the raw `onLeave` plus `familyId`: its hook checks the binding once, BEFORE
     *  it clears storage; the leave block's bound callback would add a second read after the clear. */
    it("hands the delete block the raw onLeave and the family it checks against", async () => {
      // `get` serves the binding until `clear` empties it, as the real storage does.
      let stored: Record<string, unknown> = VIEWER_BINDING;
      vi.mocked(chrome.storage.local.get).mockImplementation(((
        _keys: unknown,
        callback?: (result: Record<string, unknown>) => void,
      ) => {
        const result = { [DISPLAY_NAME_KEY]: "小明", ...stored };
        if (typeof callback === "function") callback(result);
        return Promise.resolve(result);
      }) as never);
      vi.mocked(chrome.storage.local.clear).mockImplementationOnce((() => {
        stored = {};
        return Promise.resolve();
      }) as never);
      const onLeave = vi.fn();
      renderFamilySettings({ onLeave });

      fireEvent.click(screen.getByText("移除帳戶"));
      await waitFor(() => {
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });
      const readsBefore = bindingReads();
      fireEvent.click(screen.getByText("確定移除"));

      await waitFor(() => {
        expect(onLeave).toHaveBeenCalledOnce();
      });
      // Let a bound callback's post-clear read land, if there were one.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(bindingReads()).toBe(readsBefore + 1);
      expect(onLeave).toHaveBeenCalledOnce();
      expect(chrome.storage.local.clear).toHaveBeenCalledOnce();
      expect(stored).toEqual({});
    });

    it("shows owner error when OWNER_CANNOT_DELETE", async () => {
      const apiClient = createMockApiClient({
        deleteAccount: vi.fn().mockResolvedValue({
          error: {
            code: "OWNER_CANNOT_DELETE",
            message: "Owner cannot delete",
          },
        }),
      });
      renderFamilySettings({ apiClient });

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定移除")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("確定移除"));

      await waitFor(() => {
        expect(
          screen.getByText("管理者必須先轉移管理權才能移除帳戶"),
        ).toBeInTheDocument();
      });
    });

    it("cancel returns to idle delete state", async () => {
      renderFamilySettings();

      fireEvent.click(screen.getByText("移除帳戶"));

      await waitFor(() => {
        expect(screen.getByText("確定要移除帳戶嗎？")).toBeInTheDocument();
      });

      // Find cancel buttons; last one is for delete section
      const cancelButtons = screen.getAllByText("取消");
      fireEvent.click(cancelButtons[cancelButtons.length - 1]);

      await waitFor(() => {
        expect(screen.getByText("移除帳戶")).toBeInTheDocument();
        expect(
          screen.queryByText("確定要移除帳戶嗎？"),
        ).not.toBeInTheDocument();
      });
    });
  });

  /** The owner-chosen `apiEndpoint` must not be adopted silently — the Settings tab asks first
   *  (src/dialog/useEndpointSwitch.ts). See the file header, "Endpoint switch". */
  describe("family endpoint switch confirmation", () => {
    const CURRENT_ENDPOINT = "https://current.example";
    const FAMILY_ENDPOINT = "https://family.example";

    /** Members response carrying the family record's advertised endpoint. */
    function membersWithEndpoint(apiEndpoint: string | null) {
      return vi.fn().mockResolvedValue({
        data: {
          familyId: "fam-123",
          ownerId: "user-abc12345",
          members: [{ userId: "user-abc12345", displayName: "小明" }],
          maxMembers: 6,
          createdAt: "2026-01-01",
          apiEndpoint,
        },
      });
    }

    /** STATEFUL mock: `setEndpoint` moves `getEndpoint` through the production validator; `opts.setEndpoint`
     *  replaces that (a refusing client). See the file header, "Endpoint switch". */
    function renderWithEndpoints(opts: {
      current: string;
      family: string | null;
      setEndpoint?: (url: string) => void;
    }): ApiClient {
      let endpoint = opts.current;
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn(() => endpoint),
        setEndpoint: vi.fn((url: string) => {
          if (opts.setEndpoint) {
            opts.setEndpoint(url);
            return;
          }
          endpoint = validateEndpointUrl(url);
        }),
        getFamilyMembers: membersWithEndpoint(opts.family),
      });
      renderFamilySettings({ apiClient });
      return apiClient;
    }

    /** Render, then settle the endpoint decision inside `act` — the panel is a three-deep effect chain
     *  `findByTestId` cannot wait for. See the file header, "Endpoint switch". */
    async function renderSettledEndpoints(opts: {
      current: string;
      family: string | null;
      setEndpoint?: (url: string) => void;
    }): Promise<ApiClient> {
      let apiClient!: ApiClient;
      await act(async () => {
        apiClient = renderWithEndpoints(opts);
      });
      // getBy, not findBy: an unsettled load fails loudly here. The member-count suffix is the tell that
      // membersState is "ready" (FamilySettingsMembersBlock.tsx); the display name renders from storage earlier.
      expect(screen.getByText("家庭成員 (1)")).toBeInTheDocument();
      return apiClient;
    }

    /** The confirmation panel. getBy as above: after a settled render the decision is committed, so a
     *  fixture that should have raised the question fails here rather than in a waiter. */
    function getEndpointSwitchPanel(): HTMLElement {
      return screen.getByTestId("endpoint-switch");
    }

    /** The sync code as currently rendered (settle the render first). */
    function readSyncCode(): string {
      return screen.getByTestId("sync-code").textContent ?? "";
    }

    /** Storage binding the family the screen is rendered for (`renderFamilySettings`' default). */
    const BOUND_FAMILY = { [FAMILY_ID_KEY]: "fam-123" };

    beforeEach(() => {
      mockStorageGet(BOUND_FAMILY);
    });

    /** Press 確認切換 and settle the confirm, which reads the stored binding before it switches. */
    async function clickConfirm(panel: HTMLElement): Promise<void> {
      await act(async () => {
        fireEvent.click(within(panel).getByText("確認切換"));
      });
    }

    it("asks before adopting the endpoint the family record advertises", async () => {
      await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = getEndpointSwitchPanel();

      // It interrupts the Settings tab with a security decision, so it is
      // announced to assistive tech the moment it appears.
      expect(panel).toHaveAttribute("role", "alert");
      expect(
        within(panel).getByText("⚠️ 家庭 API 端點已變更"),
      ).toBeInTheDocument();
      expect(within(panel).getByText("目前連線")).toBeInTheDocument();
      expect(within(panel).getByText(CURRENT_ENDPOINT)).toBeInTheDocument();
      expect(within(panel).getByText("將切換至")).toBeInTheDocument();
      expect(within(panel).getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
      expect(
        within(panel).getByText(
          "切換後要重新加入家庭：你的 PIN 或圖形驗證（如果有設定）與完整書單（包含未開放的書籍）都會傳送到新的伺服器。請確認你信任這個位址再切換。如果你用的是隨機驗證碼，請先改成 PIN 或圖形驗證再切換，否則可能無法重新加入。",
        ),
      ).toBeInTheDocument();
      expect(
        within(panel).getByText(
          "選擇「暫不切換」後會保持目前的連線，除非家庭端點再次變更，否則不會再詢問。",
        ),
      ).toBeInTheDocument();
      // Keeping the current endpoint is the safe choice, so it comes first.
      expect(
        within(panel)
          .getAllByRole("button")
          .map((btn) => btn.textContent),
      ).toEqual(["暫不切換", "確認切換"]);
    });

    it("labels a revert to the official default endpoint", async () => {
      await renderSettledEndpoints({ current: CURRENT_ENDPOINT, family: null });

      const panel = getEndpointSwitchPanel();

      expect(
        within(panel).getByText("將切換至（官方預設端點）"),
      ).toBeInTheDocument();
      expect(within(panel).queryByText("將切換至")).not.toBeInTheDocument();
      expect(within(panel).getByText(DEFAULT_API_ENDPOINT)).toBeInTheDocument();
    });

    it("asks nothing when the family endpoint is already in effect", async () => {
      await renderSettledEndpoints({
        current: FAMILY_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      // The panel is mounted unconditionally, so "nothing to say" must render
      // as nothing at all — neither the question nor a failure notice.
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("endpoint-switch-error"),
      ).not.toBeInTheDocument();
    });

    it("asks nothing while the member list is still loading", async () => {
      let resolveMembers: (value: unknown) => void = () => {};
      const apiClient = createMockApiClient({
        getEndpoint: vi.fn().mockReturnValue(CURRENT_ENDPOINT),
        getFamilyMembers: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveMembers = resolve;
            }),
        ),
      });
      renderFamilySettings({ apiClient });

      await act(async () => {});
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      await act(async () => {
        resolveMembers({
          data: {
            familyId: "fam-123",
            ownerId: "user-abc12345",
            members: [{ userId: "user-abc12345", displayName: "小明" }],
            maxMembers: 6,
            createdAt: "2026-01-01",
            apiEndpoint: FAMILY_ENDPOINT,
          },
        });
      });

      expect(await screen.findByTestId("endpoint-switch")).toBeInTheDocument();
    });

    it("confirm switches the client, persists the endpoint, and closes the panel", async () => {
      const apiClient = await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = getEndpointSwitchPanel();
      await clickConfirm(panel);

      expect(apiClient.setEndpoint).toHaveBeenCalledWith(FAMILY_ENDPOINT);
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [API_ENDPOINT_KEY]: FAMILY_ENDPOINT,
        });
      });
      await waitFor(() => {
        expect(chrome.storage.local.remove).toHaveBeenCalledWith([
          DECLINED_FAMILY_ENDPOINT_KEY,
        ]);
      });
      // Accepting must never leave a refusal behind.
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({
          [DECLINED_FAMILY_ENDPOINT_KEY]: expect.anything(),
        }),
      );
    });

    it("decline records the refusal and leaves the endpoint untouched", async () => {
      const apiClient = await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = getEndpointSwitchPanel();
      fireEvent.click(within(panel).getByText("暫不切換"));

      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(apiClient.setEndpoint).not.toHaveBeenCalled();

      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
        });
      });
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
    });

    it("does not ask again for an endpoint the user already declined", async () => {
      mockStorageGet({
        ...BOUND_FAMILY,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
      });

      await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
    });

    it("asks again once the family record moves to a different endpoint", async () => {
      mockStorageGet({
        ...BOUND_FAMILY,
        [DECLINED_FAMILY_ENDPOINT_KEY]: { value: "https://declined.example" },
      });

      await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      const panel = getEndpointSwitchPanel();
      expect(within(panel).getByText(FAMILY_ENDPOINT)).toBeInTheDocument();
    });

    it("drops the in-memory token on confirm and states a failed storage write", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
      const apiClient = await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      await clickConfirm(getEndpointSwitchPanel());

      expect(apiClient.setAuthToken).toHaveBeenCalledWith(null);
      const notice = await screen.findByTestId("endpoint-switch-save-error");
      expect(
        within(notice).getByText("無法儲存切換結果，請重新整理頁面。"),
      ).toBeInTheDocument();

      fireEvent.click(within(notice).getByText("知道了"));

      expect(
        screen.queryByTestId("endpoint-switch-save-error"),
      ).not.toBeInTheDocument();
      warn.mockRestore();
    });

    it("keeps the current endpoint when the client rejects the family endpoint", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const apiClient = await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
        setEndpoint: () => {
          throw new Error("Unsafe API endpoint scheme");
        },
      });

      const panel = getEndpointSwitchPanel();
      await clickConfirm(panel);

      expect(apiClient.setEndpoint).toHaveBeenCalledWith(FAMILY_ENDPOINT);
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      // A panel that just closes reads as "switched successfully", so the refusal is stated — asserted on
      // the rendered production output (src/dialog/EndpointSwitchPanel.tsx), never a copy of it.
      const notice = await screen.findByTestId("endpoint-switch-error");
      expect(notice).toHaveAttribute("role", "alert");
      expect(
        within(notice).getByText(
          "此位址無法使用（需為 HTTPS，或本機／私人網路的 HTTP），已略過此次切換。",
        ),
      ).toBeInTheDocument();

      // Nothing changed, and the unusable value is filed as declined so a
      // broken record cannot re-open the panel on every members refresh.
      await waitFor(() => {
        expect(chrome.storage.local.set).toHaveBeenCalledWith({
          [DECLINED_FAMILY_ENDPOINT_KEY]: { value: FAMILY_ENDPOINT },
        });
      });
      expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ [API_ENDPOINT_KEY]: expect.anything() }),
      );
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it("dismisses the failure notice with 「知道了」 and leaves the question closed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
        setEndpoint: () => {
          throw new Error("Unsafe API endpoint scheme");
        },
      });

      const panel = getEndpointSwitchPanel();
      await clickConfirm(panel);

      const notice = await screen.findByTestId("endpoint-switch-error");
      fireEvent.click(within(notice).getByText("知道了"));

      await waitFor(() => {
        expect(
          screen.queryByTestId("endpoint-switch-error"),
        ).not.toBeInTheDocument();
      });
      // Acknowledging is not a retry: the refused value stays declined, so the
      // confirmation panel must not reappear behind the dismissed notice.
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();

      warn.mockRestore();
    });

    // Another tab left this family and joined another (#498). See the file header, "Endpoint switch".
    it("refuses the confirm and says so once storage binds another family", async () => {
      mockStorageGet({ [FAMILY_ID_KEY]: "fam-999" });
      const apiClient = await renderSettledEndpoints({
        current: CURRENT_ENDPOINT,
        family: FAMILY_ENDPOINT,
      });

      await clickConfirm(getEndpointSwitchPanel());

      const notice = screen.getByTestId("endpoint-switch-binding-gone");
      expect(notice).toHaveAttribute("role", "alert");
      expect(
        within(notice).getByText(
          "這個視窗的資料已過期，沒有切換伺服器。請關閉書櫃後重新開啟。",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      expect(apiClient.setEndpoint).not.toHaveBeenCalled();
      expect(apiClient.setAuthToken).not.toHaveBeenCalled();
      for (const key of [API_ENDPOINT_KEY, DECLINED_FAMILY_ENDPOINT_KEY]) {
        expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
          expect.objectContaining({ [key]: expect.anything() }),
        );
      }
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
      expect(readSyncCode()).toBe(`moo-fam-123@${CURRENT_ENDPOINT}`);

      fireEvent.click(within(notice).getByText("知道了"));

      expect(
        screen.queryByTestId("endpoint-switch-binding-gone"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
    });

    /** The sync code's `@host` follows the endpoint this device ADOPTED, never the record's — else a
     *  decliner still distributes the refused host. See the file header, "Endpoint switch". */
    describe("sync code follows the adopted endpoint", () => {
      it("carries no @host while this device is on the official default", async () => {
        await renderSettledEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: null,
        });

        expect(readSyncCode()).toBe("moo-fam-123");
      });

      it("carries the @host when owner and member are already aligned on a custom endpoint", async () => {
        await renderSettledEndpoints({
          current: FAMILY_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        expect(readSyncCode()).toBe(`moo-fam-123@${FAMILY_ENDPOINT}`);
        // Aligned already, so there was nothing to confirm.
        expect(screen.queryByTestId("endpoint-switch")).not.toBeInTheDocument();
      });

      it("keeps the code @host-free after declining a switch to a custom endpoint", async () => {
        await renderSettledEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = getEndpointSwitchPanel();
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          "moo-fam-123",
        );

        fireEvent.click(within(panel).getByText("暫不切換"));

        // The refused endpoint must not travel out in the invite.
        const code = readSyncCode();
        expect(code).toBe("moo-fam-123");
        expect(code).not.toContain(FAMILY_ENDPOINT);
      });

      it("keeps the custom @host after declining a revert to the official default", async () => {
        await renderSettledEndpoints({
          current: CURRENT_ENDPOINT,
          family: null,
        });

        const panel = getEndpointSwitchPanel();
        fireEvent.click(within(panel).getByText("暫不切換"));

        // This device stays on its custom endpoint, so an invite that dropped
        // the @host would send the invitee to the wrong (default) server.
        expect(readSyncCode()).toBe(`moo-fam-123@${CURRENT_ENDPOINT}`);
      });

      it("adds the new @host as soon as a switch is confirmed, with no reopen", async () => {
        await renderSettledEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = getEndpointSwitchPanel();
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          "moo-fam-123",
        );

        await clickConfirm(panel);

        // Same mount: `apiClient.setEndpoint` alone would not re-render, so the
        // code would otherwise stay stale until the dialog was reopened.
        await waitFor(() => {
          expect(screen.getByTestId("sync-code")).toHaveTextContent(
            `moo-fam-123@${FAMILY_ENDPOINT}`,
          );
        });
      });

      it("drops the @host as soon as a revert to the official default is confirmed", async () => {
        await renderSettledEndpoints({
          current: CURRENT_ENDPOINT,
          family: null,
        });

        const panel = getEndpointSwitchPanel();
        expect(screen.getByTestId("sync-code")).toHaveTextContent(
          `moo-fam-123@${CURRENT_ENDPOINT}`,
        );

        await clickConfirm(panel);

        await waitFor(() => {
          expect(screen.getByTestId("sync-code").textContent).toBe(
            "moo-fam-123",
          );
        });
      });

      it("keeps the current @host when a confirmed switch is refused by URL validation", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await renderSettledEndpoints({
          current: CURRENT_ENDPOINT,
          family: FAMILY_ENDPOINT,
          setEndpoint: () => {
            throw new Error("Unsafe API endpoint scheme");
          },
        });

        const panel = getEndpointSwitchPanel();
        await clickConfirm(panel);

        await screen.findByTestId("endpoint-switch-error");
        // Nothing switched, so nothing about the shared code may change.
        expect(screen.getByTestId("sync-code").textContent).toBe(
          `moo-fam-123@${CURRENT_ENDPOINT}`,
        );

        warn.mockRestore();
      });

      it("copies the adopted-endpoint code, not the family record's", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });

        await renderSettledEndpoints({
          current: DEFAULT_API_ENDPOINT,
          family: FAMILY_ENDPOINT,
        });

        const panel = getEndpointSwitchPanel();
        fireEvent.click(within(panel).getByText("暫不切換"));
        // What the copy button is about to read, pinned before it is pressed.
        expect(readSyncCode()).toBe("moo-fam-123");

        fireEvent.click(screen.getByText("複製同步碼"));

        await waitFor(() => expect(writeText).toHaveBeenCalled());
        const copied = writeText.mock.calls[0][0] as string;
        expect(copied).toContain("moo-fam-123");
        expect(copied).not.toContain(FAMILY_ENDPOINT);
      });
    });
  });
});
